import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { mcpConfigType } from '@/config/schema';
import { createUiRoutes } from '@/gateway/ui_routes';
import { createMcpUpstreamManager } from '@/mcp_upstreams/manager';
import { startFixtureBackend } from '@/mcp_upstreams/protocol_fixture';
import type { TrafficStore } from '@/server/traffic_store';
import {
	CURRENT_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, test } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of [
		'http',
		'stdio',
	] as const) {
		test(`${version} ${transport}: manual refresh fetches changed tools and preserves exposure`, async () => {
			const originalCwd = process.cwd();
			const root = await mkdtemp(path.join(originalCwd, '.mcpx-refresh-'));
			const catalogPath = path.join(root, 'tools.json');
			let holdNextToolsRequest = false;
			const held = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const tool = (name: string, description = name) => ({
				name,
				description,
				inputSchema: {
					type: 'object',
				},
			});
			await Bun.write(
				catalogPath,
				JSON.stringify([
					tool('keep'),
					tool('remove'),
					tool('off'),
				]),
			);
			const fixture = startFixtureBackend(transport, version, {
				catalogPath,
				handle: async (message) => {
					if (message.method !== 'tools/list' || !holdNextToolsRequest)
						return undefined;
					holdNextToolsRequest = false;
					held.resolve();
					await release.promise;
					return undefined;
				},
			});
			const backend = fixture.config;
			const config = mcpConfigType.assert({
				mcpServers: {
					selected: {
						...backend,
						timeout: 2000,
						trafficLimit: 10000,
						enabledTools: [
							'keep',
							'remove',
							'previously-discovered',
						],
						availableTools: [
							'keep',
							'remove',
							'previously-discovered',
						],
					},
					other: {
						...backend,
						timeout: 2000,
						trafficLimit: 10000,
						enabledTools: [
							'keep',
							'remove',
						],
					},
					disabled: {
						...backend,
						enabled: false,
					},
				},
			});
			const manager = createMcpUpstreamManager({
				config,
			});
			try {
				process.chdir(root);
				await manager.initialize();
				expect(
					manager.getStatuses().filter((status) => status.connected),
				).toHaveLength(2);
				const names = (backendName: string) =>
					manager
						.listAllTools()
						.get(backendName)
						?.tools.map((tool) => tool.name);
				const routes = createUiRoutes({
					mcpUpstreamManager: manager,
					buildOverview: () => ({
						tools: Object.fromEntries(manager.listAllTools()),
						statuses: manager.getStatuses(),
					}),
					shutdownSignal: new AbortController().signal,
					trafficStore: {} as unknown as TrafficStore,
				});
				await Bun.write(
					catalogPath,
					JSON.stringify([
						tool('keep', 'Updated description'),
						tool('off'),
						tool('added'),
					]),
				);
				// Passive snapshots never fetch. A modern peer's hour-long TTL also
				// keeps automatic refresh from picking up this change prematurely.
				await routes['/api/overview'].GET();
				if (version === CURRENT_PROTOCOL_VERSION)
					await manager.refreshStaleCatalogs?.();
				expect(names('selected')).toEqual([
					'keep',
					'remove',
					'off',
				]);
				const response = await routes['/api/backends/refresh'].POST(
					new Request('http://localhost/api/backends/refresh', {
						method: 'POST',
						body: JSON.stringify({
							serverName: 'selected',
						}),
					}),
				);
				expect(response.status).toBe(200);
				expect(
					(await response.json()).tools.selected.tools.map(
						(tool: { name: string }) => tool.name,
					),
				).toEqual([
					'keep',
					'off',
					'added',
				]);
				expect(
					manager.listAllTools().get('selected')?.tools[0]?.description,
				).toBe('Updated description');
				expect(names('other')).toEqual([
					'keep',
					'remove',
					'off',
				]);
				expect(
					manager.getEnabledTools({
						serverName: 'selected',
					}),
				).toEqual([
					'keep',
				]);
				expect(
					manager
						.getStatuses()
						.find((status) => status.serverName === 'selected')?.connected,
				).toBe(true);
				expect(
					manager
						.listEnabledTools()
						.get('selected')
						?.tools.map((tool) => tool.name),
				).toEqual([
					'keep',
				]);
				const persisted = mcpConfigType.assert(
					await Bun.file(path.join(root, 'mcp.json')).json(),
				);
				expect(persisted.mcpServers.selected?.availableTools).toEqual([
					'keep',
					'off',
					'added',
				]);
				expect(persisted.mcpServers.selected?.enabledTools).toEqual([
					'keep',
				]);
				// The summary button refreshes every connected backend, regardless of version.
				expect(
					(
						await routes['/api/backends/refresh'].POST(
							new Request('http://localhost/api/backends/refresh', {
								method: 'POST',
								body: '{}',
							}),
						)
					).status,
				).toBe(200);
				expect(names('other')).toEqual([
					'keep',
					'off',
					'added',
				]);
				expect(names('disabled')).toBeUndefined();
				if (transport === 'http' && version === CURRENT_PROTOCOL_VERSION) {
					// An earlier request can contain stale data even while in flight.
					// The button must wait for it and then make another backend request.
					holdNextToolsRequest = true;
					const earlierRefresh = manager.refreshCatalogs({
						serverName: 'selected',
					});
					await held.promise;
					await Bun.write(
						catalogPath,
						JSON.stringify([
							tool('keep', 'Changed during refresh'),
							tool('off'),
							tool('added'),
						]),
					);
					const buttonRefresh = manager.refreshCatalogs({
						serverName: 'selected',
					});
					release.resolve();
					await Promise.all([
						earlierRefresh,
						buttonRefresh,
					]);
					expect(
						manager.listAllTools().get('selected')?.tools[0]?.description,
					).toBe('Changed during refresh');
				}
				// Reconnecting clears the cache, but persisted discovery still lets
				// the next fetch prune removed tools rather than reject configuration.
				await manager.toggleBackend({
					serverName: 'selected',
					enabled: false,
				});
				await Bun.write(
					catalogPath,
					JSON.stringify([
						tool('off'),
						tool('added'),
					]),
				);
				await manager.toggleBackend({
					serverName: 'selected',
					enabled: true,
				});
				expect(
					manager
						.getStatuses()
						.find((status) => status.serverName === 'selected')?.connected,
				).toBe(true);
				const reconnected = mcpConfigType.assert(
					await Bun.file(path.join(root, 'mcp.json')).json(),
				);
				expect(reconnected.mcpServers.selected?.availableTools).toEqual([
					'off',
					'added',
				]);
				expect(reconnected.mcpServers.selected?.enabledTools).toEqual([]);
				// An empty catalog is a valid update and clears both persisted lists.
				await Bun.write(catalogPath, '[]');
				await manager.refreshCatalogs({
					serverName: 'other',
				});
				expect(names('other')).toEqual([]);
				const empty = mcpConfigType.assert(
					await Bun.file(path.join(root, 'mcp.json')).json(),
				);
				expect(empty.mcpServers.other?.availableTools).toEqual([]);
				expect(empty.mcpServers.other?.enabledTools).toEqual([]);
				await expect(
					manager.refreshCatalogs({
						serverName: 'disabled',
					}),
				).rejects.toThrow('not available');
				await expect(
					manager.refreshCatalogs({
						serverName: 'unknown',
					}),
				).rejects.toThrow('Unknown MCP upstream');
			} finally {
				release.resolve();
				await manager.disconnect();
				fixture.stop();
				process.chdir(originalCwd);
				await rm(root, {
					recursive: true,
					force: true,
				});
			}
		});
	}
}
