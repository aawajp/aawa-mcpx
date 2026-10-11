import { createUiRoutes } from '@/server/gateway/ui_routes';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';

import { expect, test } from 'bun:test';

const catalogOf = (serverName: string, toolNames: string[] = []) => ({
	getStatuses: () => [
		{
			serverName,
		},
	],
	listAllTools: () =>
		new Map([
			[
				serverName,
				{
					tools: toolNames.map((name) => ({
						name,
					})),
				},
			],
		]),
});

test('dashboard toggles name the backend and tool as they are', async () => {
	let toggled: unknown;
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: {
			...catalogOf('backend__one_', ['_echo']),
			async toggleTool(params: unknown): Promise<string[]> {
				toggled = params;
				return ['_echo'];
			},
		} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const toggle = (body: unknown) =>
		routes['/api/tools/toggle'].POST(
			new Request('http://localhost/api/tools/toggle', {
				method: 'POST',
				body: JSON.stringify(body),
			}),
		);
	const params = {
		serverName: 'backend__one_',
		toolName: '_echo',
		enabled: true,
	};
	const response = await toggle(params);
	expect(response.status).toBe(200);
	expect(toggled).toEqual(params);
	expect(await response.json()).toEqual({
		...params,
		enabledTools: ['_echo'],
	});
	// A namespaced name alone no longer identifies the tool.
	expect(
		(
			await toggle({
				name: 'backend__one___echo',
				enabled: true,
			})
		).status,
	).toBe(400);
});

test('backend refresh waits for fresh catalogs before returning the overview', async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let refreshed = false;
	const manager = {
		...catalogOf('selected'),
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
	for (const body of ['{', 'null', '{"serverName":42}']) {
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

test('dashboard API errors are JSON with the reason and a client status', async () => {
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: {
			...catalogOf('known', ['echo', 'disabled']),
			async refreshCatalogs(): Promise<void> {
				throw new Error('Catalog fetch failed');
			},
			async toggleTool(): Promise<string[]> {
				throw new Error('Config write failed');
			},
			async callTool(params: { toolName: string }) {
				throw params.toolName === 'disabled'
					? new BackendRpcError(
							'Tool "disabled" is unknown or disabled',
							-32602,
						)
					: new BackendRpcError('Backend exploded', -32603);
			},
		} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const post = async (
		path:
			| '/api/backends/refresh'
			| '/api/backends/toggle'
			| '/api/tools/toggle'
			| '/api/tools/call',
		body: unknown,
	) => {
		const response = await routes[path].POST(
			new Request(`http://localhost${path}`, {
				method: 'POST',
				body: JSON.stringify(body),
			}),
		);
		return [response.status, await response.json()];
	};
	expect(
		await post('/api/backends/toggle', {
			serverName: 'missing',
			enabled: true,
		}),
	).toEqual([
		404,
		{
			error: 'Unknown MCP upstream "missing"',
		},
	]);
	expect(
		await post('/api/backends/refresh', {
			serverName: 'missing',
		}),
	).toEqual([
		404,
		{
			error: 'Unknown MCP upstream "missing"',
		},
	]);
	expect(
		await post('/api/tools/toggle', {
			serverName: 'known',
			toolName: 'missing',
			enabled: true,
		}),
	).toEqual([
		404,
		{
			error: 'Unknown tool "missing" on MCP upstream "known"',
		},
	]);
	expect(
		await post('/api/tools/call', {
			serverName: 'missing',
			toolName: 'echo',
		}),
	).toEqual([
		404,
		{
			error: 'Unknown MCP upstream "missing"',
		},
	]);
	expect(
		await post('/api/tools/call', {
			serverName: 'known',
			toolName: 'disabled',
		}),
	).toEqual([
		400,
		{
			error: 'Tool "disabled" is unknown or disabled',
		},
	]);
	expect(
		await post('/api/tools/call', {
			serverName: 'known',
			toolName: 'echo',
		}),
	).toEqual([
		500,
		{
			error: 'Backend exploded',
		},
	]);
	expect(
		await post('/api/tools/toggle', {
			serverName: 'known',
			toolName: 'echo',
			enabled: false,
		}),
	).toEqual([
		500,
		{
			error: 'Config write failed',
		},
	]);
	expect(
		await post('/api/backends/refresh', {
			serverName: 'known',
		}),
	).toEqual([
		500,
		{
			error: 'Catalog fetch failed',
		},
	]);
	const [status, body] = await post('/api/tools/call', {
		serverName: 'known',
	});
	expect(status).toBe(400);
	expect(body.error).toStartWith(
		'Invalid request body: toolName must be a string',
	);
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
