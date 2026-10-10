import { createMcpUpstreamConnections } from '@/mcp_upstreams/connections';
import {
	BackendTransportError,
	ProtocolClient,
} from '@/mcp_upstreams/protocol_client';
import { fixtureReply } from '@/mcp_upstreams/protocol_fixture';
import type {
	McpUpstreamClientsMap,
	McpUpstreamServer,
	McpUpstreamStatus,
} from '@/mcp_upstreams/types';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, jest, spyOn, test } from 'bun:test';

const createHarness = (
	url = 'http://127.0.0.1/mcp',
	refreshCatalog: (server: McpUpstreamServer) => Promise<void> = async () =>
		undefined,
) => {
	const server: McpUpstreamServer = {
		serverName: 'recovery',
		serverConfig: {
			type: 'http',
			url,
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	};
	const clients: McpUpstreamClientsMap = new Map();
	const statuses = new Map<string, McpUpstreamStatus>();
	const reconnectTimers = new Map<string, Timer>();
	const connections = createMcpUpstreamConnections({
		clients,
		statuses,
		reconnectTimers,
		servers: new Map([
			[
				server.serverName,
				server,
			],
		]),
		configErrorBackends: new Set(),
		healthCheckFailures: new Map(),
		promptsCache: new Map(),
		resourcesCache: new Map(),
		toolsCache: new Map(),
		requestQueues: new Map(),
		refreshCatalog,
	});
	return {
		server,
		clients,
		statuses,
		reconnectTimers,
		connections,
	};
};

test('reconnects back off with jitter, cap traffic, and reset after recovery', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new BackendTransportError(new Error('Network unreachable')),
	);
	const random = spyOn(Math, 'random').mockReturnValue(0.5);
	const timers = spyOn(globalThis, 'setTimeout');
	const harness = createHarness();
	try {
		await harness.connections.initialize();
		for (let attempt = 0; attempt < 5; attempt += 1)
			await harness.connections.attemptReconnect(harness.server);
		expect(timers.mock.calls.map((call) => call[1])).toEqual([
			7500,
			15000,
			30000,
			45000,
			45000,
			45000,
		]);
		expect(harness.reconnectTimers.size).toBe(1);
		expect(harness.statuses.get('recovery')).toMatchObject({
			connected: false,
			errorState: 'runtime',
			actionRequired: false,
		});
		connect.mockImplementation(async function (this: ProtocolClient) {
			this.protocolVersion = CURRENT_PROTOCOL_VERSION;
		});
		await harness.connections.attemptReconnect(harness.server);
		expect(harness.reconnectTimers.size).toBe(0);
		expect(harness.statuses.get('recovery')?.connected).toBe(true);
		harness.clients
			.get('recovery')
			?.ontransporterror(new Error('Connection reset'));
		expect(timers.mock.calls.at(-1)?.[1]).toBe(7500);
		await harness.connections.setBackendEnabled(harness.server, false);
		expect(harness.reconnectTimers.size).toBe(0);
		await harness.connections.attemptReconnect(harness.server);
		expect(connect).toHaveBeenCalledTimes(7);
	} finally {
		await harness.connections.disconnect();
		timers.mockRestore();
		random.mockRestore();
		connect.mockRestore();
	}
});

test('concurrent reconnects share one handshake and catalog refresh', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new BackendTransportError(new Error('Offline')),
	);
	let refreshes = 0;
	const harness = createHarness(undefined, async () => {
		refreshes += 1;
	});
	let release = (): void => undefined;
	try {
		await harness.connections.initialize();
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		connect.mockImplementation(async () => pending);
		const first = harness.connections.attemptReconnect(harness.server);
		const second = harness.connections.attemptReconnect(harness.server);
		await Bun.sleep(0);
		expect(connect).toHaveBeenCalledTimes(2);
		release();
		await Promise.all([
			first,
			second,
		]);
		expect(refreshes).toBe(1);
		expect(harness.reconnectTimers.size).toBe(0);
	} finally {
		release();
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});

test('shutdown during a reconnect cannot recreate a client or retry timer', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new BackendTransportError(new Error('Offline')),
	);
	const harness = createHarness();
	let release = (): void => undefined;
	try {
		await harness.connections.initialize();
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		connect.mockImplementation(async () => pending);
		const reconnect = harness.connections.attemptReconnect(harness.server);
		await Bun.sleep(0);
		await harness.connections.disconnect();
		release();
		await reconnect;
		expect(harness.clients.size).toBe(0);
		expect(harness.reconnectTimers.size).toBe(0);
		await harness.connections.attemptReconnect(harness.server);
		expect(connect).toHaveBeenCalledTimes(2);
	} finally {
		release();
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});

test('a backend reconnects automatically when the outage ends', async () => {
	let online = false;
	let discoveries = 0;
	let refreshes = 0;
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const message = recordOf(await request.json()) ?? {};
			discoveries += 1;
			if (!online)
				return new Response('Unavailable', {
					status: 503,
				});
			return Response.json(fixtureReply(message, CURRENT_PROTOCOL_VERSION));
		},
	});
	const random = spyOn(Math, 'random').mockReturnValue(0);
	const harness = createHarness(endpoint.url.href, async () => {
		refreshes += 1;
	});
	jest.useFakeTimers();
	try {
		await harness.connections.initialize();
		expect(harness.statuses.get('recovery')).toMatchObject({
			connected: false,
			actionRequired: false,
		});
		online = true;
		jest.advanceTimersByTime(5000);
		for (
			let turn = 0;
			turn < 1000 && !harness.statuses.get('recovery')?.connected;
			turn += 1
		)
			await new Promise((resolve) => setImmediate(resolve));
		expect(harness.statuses.get('recovery')?.connected).toBe(true);
		expect(discoveries).toBe(2);
		expect(refreshes).toBe(1);
		expect(harness.reconnectTimers.size).toBe(0);
	} finally {
		jest.useRealTimers();
		await harness.connections.disconnect();
		random.mockRestore();
		endpoint.stop(true);
	}
});

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	test(`${version}: request failure recovers the backend without replaying the tool`, async () => {
		let failed = false;
		let toolCalls = 0;
		let refreshes = 0;
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				const message = recordOf(await request.json()) ?? {};
				if (message.method === 'tools/call') {
					toolCalls += 1;
					if (failed)
						return new Response('Session gone', {
							status: version === CURRENT_PROTOCOL_VERSION ? 503 : 404,
						});
				}
				if (!('id' in message))
					return new Response(null, {
						status: 202,
					});
				return Response.json(fixtureReply(message, version), {
					status:
						message.method === 'server/discover' &&
						version !== CURRENT_PROTOCOL_VERSION
							? 400
							: 200,
					headers:
						message.method === 'initialize'
							? {
									'Mcp-Session-Id': 'fixture-session',
								}
							: undefined,
				});
			},
		});
		const harness = createHarness(endpoint.url.href, async () => {
			refreshes += 1;
		});
		try {
			await harness.connections.initialize();
			const client = harness.clients.get('recovery');
			if (!client) throw new Error('Missing client');
			failed = true;
			await expect(
				client.callTool({
					name: 'echo',
					arguments: {},
				}),
			).rejects.toThrow();
			expect(harness.statuses.get('recovery')?.connected).toBe(false);
			expect(harness.reconnectTimers.size).toBe(1);
			failed = false;
			await harness.connections.attemptReconnect(harness.server);
			expect(harness.statuses.get('recovery')).toMatchObject({
				connected: true,
				protocolVersion: version,
			});
			expect(refreshes).toBe(2);
			expect(toolCalls).toBe(1);
			client.ontransporterror(new Error('Late error from old client'));
			expect(harness.statuses.get('recovery')?.connected).toBe(true);
		} finally {
			await harness.connections.disconnect();
			endpoint.stop(true);
		}
	});
}
