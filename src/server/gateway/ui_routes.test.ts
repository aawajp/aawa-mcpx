import { createUiRoutes } from '@/server/gateway/ui_routes';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { addPrefix } from '@/shared/mcp_namespaces';

import { expect, test } from 'bun:test';

test('dashboard toggles use the same escaped namespaces as the MCP catalog', async () => {
	let toggled: unknown;
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: {
			async toggleTool(params: unknown): Promise<string[]> {
				toggled = params;
				return [
					'_echo',
				];
			},
		} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const response = await routes['/api/tools/toggle'].POST(
		new Request('http://localhost/api/tools/toggle', {
			method: 'POST',
			body: JSON.stringify({
				name: addPrefix({
					serverName: 'backend__one_',
					name: '_echo',
				}),
				enabled: true,
			}),
		}),
	);
	expect(response.status).toBe(200);
	expect(toggled).toEqual({
		serverName: 'backend__one_',
		toolName: '_echo',
		enabled: true,
	});
});

test('backend refresh waits for fresh catalogs before returning the overview', async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let refreshed = false;
	const manager = {
		async refreshCatalogs(params?: { serverName?: string }): Promise<void> {
			expect(params?.serverName).toBe('selected');
			started.resolve();
			await release.promise;
			refreshed = true;
		},
	} as unknown as McpUpstreamManager;
	const routes = createUiRoutes({
		buildOverview: () => ({
			refreshed,
		}),
		mcpUpstreamManager: manager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const pending = routes['/api/backends/refresh'].POST(
		new Request('http://localhost/api/backends/refresh', {
			method: 'POST',
			body: JSON.stringify({
				serverName: 'selected',
			}),
		}),
	);
	await started.promise;
	expect(refreshed).toBe(false);
	release.resolve();
	const response = await pending;
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		refreshed: true,
	});
});

test('backend refresh rejects malformed requests without fetching catalogs', async () => {
	let calls = 0;
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: {
			async refreshCatalogs(): Promise<void> {
				calls += 1;
			},
		} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	for (const body of [
		'{',
		'null',
		'{"serverName":42}',
	]) {
		const response = await routes['/api/backends/refresh'].POST(
			new Request('http://localhost/api/backends/refresh', {
				method: 'POST',
				body,
			}),
		);
		expect(response.status).toBe(400);
	}
	expect(calls).toBe(0);
});

test('shutdown closes active UI event streams', async () => {
	const shutdownController = new AbortController();
	const routes = createUiRoutes({
		buildOverview: () => ({
			status: 'ok',
		}),
		mcpUpstreamManager: {} as unknown as McpUpstreamManager,
		shutdownSignal: shutdownController.signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const response = await routes['/api/events'].GET(
		new Request('http://localhost/api/events'),
	);
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Expected UI event stream response body');
	}

	const initialEvent = await reader.read();
	expect(initialEvent.done).toBe(false);

	shutdownController.abort();
	expect(await reader.read()).toEqual({
		done: true,
		value: undefined,
	});
});
