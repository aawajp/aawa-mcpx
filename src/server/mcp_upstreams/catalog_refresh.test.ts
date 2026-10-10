import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mcpConfigType } from '@/server/config/schema';
import { createUiRoutes } from '@/server/gateway/ui_routes';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { startFixtureBackend } from '@/server/mcp_upstreams/protocol_fixture';
import type { TrafficStore } from '@/server/traffic_store';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, test } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of ['http', 'stdio'] as const) {
		test(`${version} ${transport}: manual refresh fetches changed tools and preserves exposure`, async () => {
			const root = await mkdtemp(path.join(tmpdir(), 'mcpx-refresh-'));
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
				JSON.stringify([tool('keep'), tool('remove'), tool('off')]),
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
						enabledTools: ['keep', 'remove', 'previously-discovered'],
						availableTools: ['keep', 'remove', 'previously-discovered'],
					},
					other: {
						...backend,
						timeout: 2000,
						trafficLimit: 10000,
						enabledTools: ['keep', 'remove'],
					},
					disabled: {
						...backend,
						enabled: false,
					},
				},
			});
			const manager = createMcpUpstreamManager({
				config,
				configPath: path.join(root, 'mcp.json'),
			});
			try {
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
					await manager.refreshStaleCatalogs?.({
						method: 'tools/list',
					});
				expect(names('selected')).toEqual(['keep', 'remove', 'off']);
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
				).toEqual(['keep', 'off', 'added']);
				expect(
					manager.listAllTools().get('selected')?.tools[0]?.description,
				).toBe('Updated description');
				expect(names('other')).toEqual(['keep', 'remove', 'off']);
				expect(
					manager.getEnabledTools({
						serverName: 'selected',
					}),
				).toEqual(['keep']);
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
				).toEqual(['keep']);
				const persisted = mcpConfigType.assert(
					await Bun.file(path.join(root, 'mcp.json')).json(),
				);
				expect(persisted.mcpServers.selected?.availableTools).toEqual([
					'keep',
					'off',
					'added',
				]);
				expect(persisted.mcpServers.selected?.enabledTools).toEqual(['keep']);
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
				expect(names('other')).toEqual(['keep', 'off', 'added']);
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
					await Promise.all([earlierRefresh, buttonRefresh]);
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
					JSON.stringify([tool('off'), tool('added')]),
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
				await rm(root, {
					recursive: true,
					force: true,
				});
			}
		});
	}
}

test('2026-07-28 lists go stale on their own and refresh only for the request target', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mcpx-stale-'));
	const requests: string[] = [];
	let failTools = false;
	const start = (name: string) =>
		startFixtureBackend('http', CURRENT_PROTOCOL_VERSION, {
			handle: (message, reply) => {
				const method = String(message.method);
				if (!method.endsWith('/list')) return undefined;
				requests.push(`${name} ${method}`);
				if (failTools && method === 'tools/list')
					return Response.json({
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32603,
							message: 'Temporarily unavailable',
						},
					});
				// Tools go stale at once; prompts and resources stay fresh.
				const result = recordOf(reply?.result);
				if (result && method !== 'tools/list') result.ttlMs = 3_600_000;
				return undefined;
			},
		});
	const fixtures = [start('a'), start('b')];
	const manager = createMcpUpstreamManager({
		config: mcpConfigType.assert({
			mcpServers: Object.fromEntries(
				fixtures.map((fixture, index) => [
					index === 0 ? 'a' : 'b',
					{
						...fixture.config,
						timeout: 2000,
						trafficLimit: 10000,
					},
				]),
			),
		}),
		configPath: path.join(root, 'mcp.json'),
	});
	try {
		await manager.initialize();
		expect(
			manager.listAllResourceTemplates().get('a')?.resourceTemplates,
		).toEqual([
			{
				name: 'logs',
				uriTemplate: 'file:///logs/{name}',
			},
		]);
		requests.length = 0;

		await manager.refreshStaleCatalogs?.({
			method: 'tools/call',
			params: {
				name: 'a__echo',
			},
		});
		expect(requests).toEqual(['a tools/list']);

		requests.length = 0;
		await manager.refreshStaleCatalogs?.({
			method: 'prompts/list',
		});
		await manager.refreshStaleCatalogs?.({
			method: 'resources/templates/list',
		});
		await manager.refreshStaleCatalogs?.({
			method: 'prompts/get',
			params: {
				name: 'a__greet',
			},
		});
		expect(requests).toEqual([]);

		await manager.refreshStaleCatalogs?.({
			method: 'tools/list',
		});
		expect(requests.toSorted((x, y) => x.localeCompare(y))).toEqual([
			'a tools/list',
			'b tools/list',
		]);

		// A failed re-fetch keeps serving the stale list.
		requests.length = 0;
		failTools = true;
		await manager.refreshStaleCatalogs?.({
			method: 'tools/call',
			params: {
				name: 'a__echo',
			},
		});
		expect(requests).toEqual(['a tools/list']);
		expect(
			manager
				.listAllTools()
				.get('a')
				?.tools.map((tool) => tool.name),
		).toEqual(['echo']);
	} finally {
		await manager.disconnect();
		for (const fixture of fixtures) fixture.stop();
		await rm(root, {
			recursive: true,
			force: true,
		});
	}
});

test('2026-07-28 manual refresh updates server info, capabilities and instructions', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mcpx-details-'));
	let release = '1';
	const fixture = startFixtureBackend('http', CURRENT_PROTOCOL_VERSION, {
		handle: (message, reply) => {
			const result = recordOf(reply?.result);
			if (message.method !== 'server/discover' || !result) return undefined;
			result.instructions = `Use release ${release}`;
			result._meta = {
				[SERVER_INFO_META]: {
					name: 'fixture',
					version: release,
				},
			};
			if (release === '2') delete recordOf(result.capabilities)?.prompts;
			return undefined;
		},
	});
	const manager = createMcpUpstreamManager({
		config: mcpConfigType.assert({
			mcpServers: {
				backend: {
					...fixture.config,
					timeout: 2000,
					trafficLimit: 10000,
				},
			},
		}),
		configPath: path.join(root, 'mcp.json'),
	});
	const status = () =>
		manager.getStatuses().find((entry) => entry.serverName === 'backend');
	try {
		await manager.initialize();
		expect(status()).toMatchObject({
			instructions: 'Use release 1',
			implementation: {
				version: '1',
			},
		});
		release = '2';
		await manager.refreshCatalogs({
			serverName: 'backend',
		});
		expect(status()).toMatchObject({
			connected: true,
			instructions: 'Use release 2',
			implementation: {
				version: '2',
			},
		});
		expect(status()?.capabilities?.prompts).toBeUndefined();
	} finally {
		await manager.disconnect();
		fixture.stop();
		await rm(root, {
			recursive: true,
			force: true,
		});
	}
});
