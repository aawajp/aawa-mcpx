import type { TrafficStore } from '@/server/db/traffic';
import { createUiRoutes } from '@/server/gateway/ui_routes';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';

import { expect, test } from 'bun:test';

const catalogOf = (serverName: string, availableTools: string[] = []) => ({
	getStatuses: () => [
		{
			serverName,
			availableTools,
		},
	],
});

test('dashboard toggles name the backend and tool as they are and return the overview', async () => {
	let toggled: unknown;
	const routes = createUiRoutes({
		buildOverview: () => ({
			toggled,
		}),
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
		toggled: params,
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
	expect(
		(
			await toggle({
				...params,
				extra: true,
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
			...catalogOf('known', ['echo']),
			async refreshCatalogs(): Promise<void> {
				throw new Error('Catalog fetch failed');
			},
			async toggleTool(): Promise<string[]> {
				throw new Error('Config write failed');
			},
		} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const post = async (
		path:
			| '/api/backends/refresh'
			| '/api/backends/toggle'
			| '/api/tools/toggle',
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

test('a UI event stream ends once its session is no longer valid', async () => {
	let loggedIn = true;
	const checked: Request[] = [];
	const routes = createUiRoutes({
		buildOverview: () => ({
			status: 'ok',
		}),
		mcpUpstreamManager: {} as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
		isLoggedIn: (request) => {
			checked.push(request);
			return loggedIn;
		},
	});
	const request = new Request('http://localhost/api/events');
	const reader = (await routes['/api/events'].GET(request)).body?.getReader();
	if (!reader) throw new Error('Expected UI event stream response body');
	expect((await reader.read()).done).toBe(false);
	loggedIn = false;
	expect(await reader.read()).toEqual({
		done: true,
		value: undefined,
	});
	expect(checked).toEqual([request]);
});

test('the health check answers only that the gateway serves', async () => {
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: catalogOf('backend', [
			'secret_tool',
		]) as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {} as unknown as TrafficStore,
	});
	const response = await routes['/api/health'].GET();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		status: 'ok',
	});
});

test('debug queries are parsed with their defaults and malformed ones are refused', async () => {
	const queries: unknown[] = [];
	const routes = createUiRoutes({
		buildOverview: () => ({}),
		mcpUpstreamManager: catalogOf('backend') as unknown as McpUpstreamManager,
		shutdownSignal: new AbortController().signal,
		trafficStore: {
			getBackendTraffic: (query: unknown) => {
				queries.push(query);
				return {
					records: [],
					total: 0,
				};
			},
		} as unknown as TrafficStore,
	});
	const get = (query: string) =>
		routes['/api/debug/backend'].GET(
			new Request(`http://localhost/api/debug/backend?${query}`),
		);

	expect((await get('backend=backend')).status).toBe(200);
	expect(
		(await get('backend=backend&limit=5&offset=10&errorsOnly=1&method=ping'))
			.status,
	).toBe(200);
	expect(queries).toEqual([
		{
			backend: 'backend',
			limit: 20,
			offset: 0,
			errorsOnly: false,
		},
		{
			backend: 'backend',
			method: 'ping',
			limit: 5,
			offset: 10,
			errorsOnly: true,
		},
	]);
	for (const query of [
		'',
		'backend=backend&limit=0',
		'backend=backend&limit=1.5',
		'backend=backend&limit=101',
		'backend=backend&offset=-1',
		'backend=backend&errorsOnly=yes',
		'backend=backend&page=2',
		'backend=backend&method=',
	]) {
		const response = await get(query);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: expect.stringMatching(/^Invalid query: /),
		});
	}
});
