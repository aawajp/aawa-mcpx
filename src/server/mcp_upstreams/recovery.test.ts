import {
	createMcpUpstreamBackend,
	createMcpUpstreamConnections,
} from '@/server/mcp_upstreams/connections';
import {
	BackendTransportError,
	ProtocolClient,
} from '@/server/mcp_upstreams/protocol_client';
import { fixtureReply } from '@/server/mcp_upstreams/protocol_fixture';
import type { McpUpstreamBackend } from '@/server/mcp_upstreams/types';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
	usesRequestMetadata,
} from '@/shared/mcp_protocol';

import { expect, it, jest, spyOn } from 'bun:test';

const createHarness = (
	url = 'http://127.0.0.1/mcp',
	refreshCatalog: (backend: McpUpstreamBackend) => Promise<void> = async () =>
		undefined,
) => {
	const backend = createMcpUpstreamBackend({
		serverName: 'recovery',
		serverConfig: {
			type: 'http',
			url,
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	const connections = createMcpUpstreamConnections({
		backends: new Map([[backend.serverName, backend]]),
		refreshCatalog,
	});
	return {
		backend,
		connections,
	};
};

it('reconnects back off with jitter, cap traffic, and reset after recovery', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new BackendTransportError(new Error('Network unreachable')),
	);
	const random = spyOn(Math, 'random').mockReturnValue(0.5);
	const timers = spyOn(globalThis, 'setTimeout');
	const harness = createHarness();
	try {
		await harness.connections.initialize();
		for (let attempt = 0; attempt < 5; attempt += 1)
			await harness.connections.attemptReconnect(harness.backend);
		expect(timers.mock.calls.map((call) => call[1])).toEqual([
			7500, 15000, 30000, 45000, 45000, 45000,
		]);
		expect(harness.backend.reconnectTimer).toBeDefined();
		expect(harness.backend.status).toMatchObject({
			connected: false,
			errorState: 'runtime',
			actionRequired: false,
		});
		connect.mockImplementation(async function (this: ProtocolClient) {
			this.protocolVersion = CURRENT_PROTOCOL_VERSION;
		});
		await harness.connections.attemptReconnect(harness.backend);
		expect(harness.backend.reconnectTimer).toBeUndefined();
		expect(harness.backend.status?.connected).toBe(true);
		harness.backend.client?.ontransporterror(new Error('Connection reset'));
		expect(timers.mock.calls.at(-1)?.[1]).toBe(7500);
		await harness.connections.setBackendEnabled(harness.backend, false);
		expect(harness.backend.reconnectTimer).toBeUndefined();
		await harness.connections.attemptReconnect(harness.backend);
		expect(connect).toHaveBeenCalledTimes(7);
	} finally {
		await harness.connections.disconnect();
		timers.mockRestore();
		random.mockRestore();
		connect.mockRestore();
	}
});

it('concurrent reconnects share one handshake and catalog refresh', async () => {
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
		const first = harness.connections.attemptReconnect(harness.backend);
		const second = harness.connections.attemptReconnect(harness.backend);
		await Bun.sleep(0);
		expect(connect).toHaveBeenCalledTimes(2);
		release();
		await Promise.all([first, second]);
		expect(refreshes).toBe(1);
		expect(harness.backend.reconnectTimer).toBeUndefined();
	} finally {
		release();
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});

it('shutdown during a reconnect cannot recreate a client or retry timer', async () => {
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
		const reconnect = harness.connections.attemptReconnect(harness.backend);
		await Bun.sleep(0);
		await harness.connections.disconnect();
		release();
		await reconnect;
		expect(harness.backend.client).toBeUndefined();
		expect(harness.backend.reconnectTimer).toBeUndefined();
		await harness.connections.attemptReconnect(harness.backend);
		expect(connect).toHaveBeenCalledTimes(2);
	} finally {
		release();
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});

it('a backend reconnects automatically when the outage ends', async () => {
	let online = false;
	let discoveries = 0;
	let refreshes = 0;
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (request.method === 'DELETE')
				return new Response(null, {
					status: 405,
				});
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
		expect(harness.backend.status).toMatchObject({
			connected: false,
			actionRequired: false,
		});
		online = true;
		jest.advanceTimersByTime(5000);
		for (
			let turn = 0;
			turn < 1000 && !harness.backend.status?.connected;
			turn += 1
		)
			await new Promise((resolve) => setImmediate(resolve));
		expect(harness.backend.status?.connected).toBe(true);
		expect(discoveries).toBe(2);
		expect(refreshes).toBe(1);
		expect(harness.backend.reconnectTimer).toBeUndefined();
	} finally {
		jest.useRealTimers();
		await harness.connections.disconnect();
		random.mockRestore();
		endpoint.stop(true);
	}
});

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	it(`${version}: request failure recovers the backend without replaying the tool`, async () => {
		let failed = false;
		let toolCalls = 0;
		let refreshes = 0;
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				if (message.method === 'tools/call') {
					toolCalls += 1;
					if (failed)
						return new Response('Session gone', {
							status: 404,
						});
				}
				if (!('id' in message))
					return new Response(null, {
						status: 202,
					});
				return Response.json(fixtureReply(message, version), {
					status:
						message.method === 'server/discover' &&
						!usesRequestMetadata(version)
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
		const fetch = spyOn(globalThis, 'fetch');
		try {
			await harness.connections.initialize();
			const client = harness.backend.client;
			if (!client) throw new Error('Missing client');
			// 2026 has no session, so its connection-level failure is a lost
			// connection.
			if (usesRequestMetadata(version))
				fetch.mockRejectedValueOnce(new TypeError('Connection reset'));
			else failed = true;
			await expect(
				client.callTool({
					name: 'echo',
					arguments: {},
				}),
			).rejects.toThrow();
			expect(harness.backend.status?.connected).toBe(false);
			expect(harness.backend.reconnectTimer).toBeDefined();
			failed = false;
			await harness.connections.attemptReconnect(harness.backend);
			expect(harness.backend.status).toMatchObject({
				connected: true,
				protocolVersion: version,
			});
			expect(refreshes).toBe(2);
			expect(toolCalls).toBe(usesRequestMetadata(version) ? 0 : 1);
			client.ontransporterror(new Error('Late error from old client'));
			expect(harness.backend.status?.connected).toBe(true);
		} finally {
			fetch.mockRestore();
			await harness.connections.disconnect();
			endpoint.stop(true);
		}
	});
}

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	it(`${version}: a timeout or 5xx fails only its own call`, async () => {
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				const mode = recordOf(recordOf(message.params)?.arguments)?.mode;
				if (mode === 'fail')
					return new Response('Unavailable', {
						status: 503,
					});
				if (mode === 'hang') await Bun.sleep(300);
				if (mode === 'slow') await Bun.sleep(100);
				if (!('id' in message))
					return new Response(null, {
						status: 202,
					});
				return Response.json(fixtureReply(message, version), {
					status:
						message.method === 'server/discover' &&
						!usesRequestMetadata(version)
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
		const harness = createHarness(endpoint.url.href);
		try {
			await harness.connections.initialize();
			const client = harness.backend.client;
			if (!client) throw new Error('Missing client');
			const slow = client.callTool({
				name: 'echo',
				arguments: {
					mode: 'slow',
				},
			});
			await expect(
				client.callTool({
					name: 'echo',
					arguments: {
						mode: 'fail',
					},
				}),
			).rejects.toMatchObject({
				status: 503,
			});
			await expect(
				client.callTool(
					{
						name: 'echo',
						arguments: {
							mode: 'hang',
						},
					},
					{
						timeout: 20,
					},
				),
			).rejects.toThrow('Backend request timed out after 20 ms');
			await expect(slow).resolves.toBeDefined();
			expect(harness.backend.client).toBe(client);
			expect(harness.backend.status?.connected).toBe(true);
			expect(harness.backend.reconnectTimer).toBeUndefined();
		} finally {
			await harness.connections.disconnect();
			endpoint.stop(true);
		}
	});
}

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	it(`${version}: a rejected credential stops retries, before and after connecting`, async () => {
		let authorized = false;
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				if (
					message.method === 'server/discover' &&
					!usesRequestMetadata(version)
				)
					return Response.json(fixtureReply(message, version), {
						status: 400,
					});
				if (!authorized)
					return new Response('Unauthorized', {
						status: 401,
					});
				if (!('id' in message))
					return new Response(null, {
						status: 202,
					});
				return Response.json(fixtureReply(message, version), {
					headers:
						message.method === 'initialize'
							? {
									'Mcp-Session-Id': 'fixture-session',
								}
							: undefined,
				});
			},
		});
		const harness = createHarness(endpoint.url.href);
		const stoppedOnCredential = {
			connected: false,
			errorState: 'authentication',
			actionRequired: true,
			error: 'Backend HTTP 401',
		};
		try {
			await harness.connections.initialize();
			expect(harness.backend.status).toMatchObject(stoppedOnCredential);
			expect(harness.backend.reconnectTimer).toBeUndefined();
			authorized = true;
			await harness.connections.attemptReconnect(harness.backend);
			expect(harness.backend.status?.connected).toBe(false);
			await harness.connections.setBackendEnabled(harness.backend, false);
			await harness.connections.setBackendEnabled(harness.backend, true);
			expect(harness.backend.status).toMatchObject({
				connected: true,
				protocolVersion: version,
			});
			authorized = false;
			harness.backend.client?.ontransporterror(new Error('Connection reset'));
			await harness.connections.attemptReconnect(harness.backend);
			expect(harness.backend.status).toMatchObject(stoppedOnCredential);
			expect(harness.backend.reconnectTimer).toBeUndefined();
		} finally {
			await harness.connections.disconnect();
			endpoint.stop(true);
		}
	});
}

it('a start failure that is not transient stops at once', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		Object.assign(new Error('Executable not found in $PATH'), {
			code: 'ENOENT',
		}),
	);
	const harness = createHarness();
	try {
		await harness.connections.initialize();
		expect(harness.backend.status).toMatchObject({
			connected: false,
			errorState: 'runtime',
			actionRequired: true,
		});
		expect(harness.backend.reconnectTimer).toBeUndefined();
		await harness.connections.attemptReconnect(harness.backend);
		expect(connect).toHaveBeenCalledTimes(1);
	} finally {
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});

it('transient start failures stop after the startup window', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockRejectedValue(
		new BackendTransportError(new Error('Connection refused')),
	);
	const now = Date.now;
	let offset = 0;
	const clock = spyOn(Date, 'now').mockImplementation(() => now() + offset);
	const harness = createHarness();
	try {
		await harness.connections.initialize();
		expect(harness.backend.status?.actionRequired).toBe(false);
		expect(harness.backend.reconnectTimer).toBeDefined();
		offset = 5 * 60_000;
		await harness.connections.attemptReconnect(harness.backend);
		expect(harness.backend.status).toMatchObject({
			connected: false,
			errorState: 'runtime',
			actionRequired: true,
		});
		expect(harness.backend.reconnectTimer).toBeUndefined();
	} finally {
		await harness.connections.disconnect();
		clock.mockRestore();
		connect.mockRestore();
	}
});

it('after a connection, failures retry unless a certificate is rejected', async () => {
	const connect = spyOn(ProtocolClient.prototype, 'connect').mockImplementation(
		async function (this: ProtocolClient) {
			this.protocolVersion = CURRENT_PROTOCOL_VERSION;
		},
	);
	const harness = createHarness();
	try {
		await harness.connections.initialize();
		expect(harness.backend.status?.connected).toBe(true);
		connect.mockRejectedValue(new Error('Invalid backend JSON response'));
		harness.backend.client?.ontransporterror(new Error('Connection reset'));
		await harness.connections.attemptReconnect(harness.backend);
		expect(harness.backend.status).toMatchObject({
			connected: false,
			actionRequired: false,
		});
		expect(harness.backend.reconnectTimer).toBeDefined();
		connect.mockRejectedValue(
			new BackendTransportError(
				Object.assign(new Error('self signed certificate'), {
					code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
				}),
			),
		);
		await harness.connections.attemptReconnect(harness.backend);
		expect(harness.backend.status).toMatchObject({
			connected: false,
			errorState: 'runtime',
			actionRequired: true,
		});
		expect(harness.backend.reconnectTimer).toBeUndefined();
	} finally {
		await harness.connections.disconnect();
		connect.mockRestore();
	}
});
