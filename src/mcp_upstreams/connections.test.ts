import { mcpConfigType } from '@/config/schema';
import { createMcpUpstreamConnections } from '@/mcp_upstreams/connections';
import {
	ProtocolClient,
	ProtocolNegotiationError,
} from '@/mcp_upstreams/protocol_client';
import type { McpUpstreamStatus } from '@/mcp_upstreams/types';

import { expect, spyOn, test } from 'bun:test';

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
	const server = {
		serverName: 'mock',
		serverConfig,
	};
	const statuses = new Map<string, McpUpstreamStatus>();
	const reconnectTimers = new Map<string, Timer>();
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
		clients: new Map(),
		configErrorBackends: new Set(),
		healthCheckFailures: new Map(),
		promptsCache: new Map(),
		reconnectTimers,
		requestQueues: new Map(),
		resourcesCache: new Map(),
		servers: new Map([
			[
				'mock',
				server,
			],
		]),
		statuses,
		suppressClientErrorsUntil: new Map(),
		toolsCache: new Map(),
		refreshCatalog: async () => undefined,
	});
	try {
		await connections.initialize();
		expect(statuses.get('mock')).toMatchObject({
			connected: false,
			errorState: 'protocol',
			actionRequired: true,
		});
		expect(statuses.get('mock')?.error).toContain(
			'server/discover (attempted 2026-07-28, HTTP 404, RPC -32601)',
		);
		expect(reconnectTimers.size).toBe(0);
		await connections.attemptReconnect(server);
		expect(connect).toHaveBeenCalledTimes(1);
		await connections.setBackendEnabled(server, false);
		await connections.setBackendEnabled(server, true);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(reconnectTimers.size).toBe(0);
	} finally {
		await connections.disconnect();
		connect.mockRestore();
	}
});
