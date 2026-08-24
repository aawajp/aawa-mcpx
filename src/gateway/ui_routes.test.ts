import { createUiRoutes } from '@/gateway/ui_routes';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';

import { expect, test } from 'bun:test';

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
