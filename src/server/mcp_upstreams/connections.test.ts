import { mcpConfigType } from '@/server/config/schema';
import {
	createMcpUpstreamBackend,
	createMcpUpstreamConnections,
} from '@/server/mcp_upstreams/connections';
import {
	ProtocolClient,
	ProtocolNegotiationError,
} from '@/server/mcp_upstreams/protocol_client';

import { expect, spyOn, test } from 'bun:test';

test('cancellation frees a rate-limit wait without reserving a dispatch time', async () => {
	const config = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://localhost/mcp',
				enabled: true,
				trafficLimit: 1,
			},
		},
	});
	const serverConfig = config.mcpServers.mock;
	if (!serverConfig) throw new Error('Missing fixture');
	const backend = createMcpUpstreamBackend({
		serverName: 'mock',
		serverConfig,
	});
	const connections = createMcpUpstreamConnections({
		backends: new Map([['mock', backend]]),
		refreshCatalog: async () => undefined,
	});
	await connections.waitForRateLimit(backend);
	const lastDispatch = backend.lastRequestTime;
	const controller = new AbortController();
	const waiting = connections.waitForRateLimit(backend, controller.signal);
	const rejection = waiting.catch((error: unknown) => error);
	controller.abort();
	expect(await rejection).toBe(controller.signal.reason);
	expect(backend.lastRequestTime).toBe(lastDispatch);
	await expect(
		connections.waitForRateLimit(backend, controller.signal),
	).rejects.toThrow();
	expect(backend.lastRequestTime).toBe(lastDispatch);
});

test('protocol failure stops reconnects until explicitly re-enabled', async () => {
	const config = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://localhost/mcp',
				enabled: true,
			},
		},
	});
	const serverConfig = config.mcpServers.mock;
	if (!serverConfig) throw new Error('Missing fixture');
	const backend = createMcpUpstreamBackend({
		serverName: 'mock',
		serverConfig,
	});
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new ProtocolNegotiationError(
			{
				method: 'server/discover',
				attemptedVersion: '2026-07-28',
				httpStatus: 404,
				rpcCode: -32601,
			},
			new Error('Method not found'),
		),
	);
	const connections = createMcpUpstreamConnections({
		backends: new Map([['mock', backend]]),
		refreshCatalog: async () => undefined,
	});
	try {
		await connections.initialize();
		expect(backend.status).toMatchObject({
			connected: false,
			errorState: 'protocol',
			actionRequired: true,
		});
		expect(backend.status?.error).toContain(
			'server/discover (attempted 2026-07-28, HTTP 404, RPC -32601)',
		);
		expect(backend.reconnectTimer).toBeUndefined();
		await connections.attemptReconnect(backend);
		expect(connect).toHaveBeenCalledTimes(1);
		await connections.setBackendEnabled(backend, false);
		await connections.setBackendEnabled(backend, true);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(backend.reconnectTimer).toBeUndefined();
	} finally {
		await connections.disconnect();
		connect.mockRestore();
	}
});

test('concurrent requests wait for their own rate-limit slots', async () => {
	const config = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://localhost/mcp',
				enabled: true,
				trafficLimit: 20,
			},
		},
	});
	const serverConfig = config.mcpServers.mock;
	if (!serverConfig) throw new Error('Missing fixture');
	const backend = createMcpUpstreamBackend({
		serverName: 'mock',
		serverConfig,
	});
	const connections = createMcpUpstreamConnections({
		backends: new Map([['mock', backend]]),
		refreshCatalog: async () => undefined,
	});
	const started = performance.now();
	const done = await Promise.all(
		Array.from(
			{
				length: 4,
			},
			async () => {
				await connections.waitForRateLimit(backend);
				return performance.now() - started;
			},
		),
	);
	// 20 requests per second: one every 50 ms.
	for (const [index, elapsed] of done.entries())
		expect(elapsed).toBeGreaterThanOrEqual(index * 50 - 5);
});
