import { createMcpUpstreamBackend } from '@/server/mcp_upstreams/connections';
import { createMcpUpstreamHealthChecks } from '@/server/mcp_upstreams/health_checks';
import type { ProtocolClient as Client } from '@/server/mcp_upstreams/protocol_client';
import type { McpUpstreamBackend } from '@/server/mcp_upstreams/types';

import { expect, spyOn, test } from 'bun:test';

const createBackend = (
	serverName: string,
	client: Client,
): McpUpstreamBackend => ({
	...createMcpUpstreamBackend({
		serverName,
		serverConfig: {
			type: 'http',
			url: `http://127.0.0.1/${serverName}`,
			enabled: true,
			timeout: 10_000,
			trafficLimit: 1,
		},
	}),
	client,
	healthCheckReady: true,
});

const createClient = (
	ping: (options: { timeout?: number }) => Promise<Record<string, never>>,
): Client =>
	({
		ping,
	}) as unknown as Client;

const createChecks = (
	backend: McpUpstreamBackend,
	markMcpUpstreamDown: () => void = () => {
		throw new Error('Unexpected down');
	},
) =>
	createMcpUpstreamHealthChecks({
		backends: new Map([[backend.serverName, backend]]),
		markMcpUpstreamDown,
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});

test('successful traffic suppresses idle pings and clears old failures', async () => {
	const now = spyOn(Date, 'now').mockReturnValue(100_000);
	let pings = 0;
	const client = createClient(async () => {
		pings += 1;
		client.lastSuccessfulRequestAt = Date.now();
		return {};
	});
	client.lastSuccessfulRequestAt = 99_000;
	const backend = createBackend('active', client);
	backend.healthCheckFailures = 1;
	const checks = createChecks(backend);
	try {
		await checks.runHealthChecks();
		expect(pings).toBe(0);
		expect(backend.healthCheckFailures).toBe(0);
		now.mockReturnValue(160_000);
		await checks.runHealthChecks();
		expect(pings).toBe(1);
		now.mockReturnValue(170_000);
		await checks.runHealthChecks();
		expect(pings).toBe(1);
	} finally {
		now.mockRestore();
	}
});

test('successful traffic during a failed health check keeps the backend healthy', async () => {
	const client = createClient(async () => {
		client.lastSuccessfulRequestAt = Date.now() + 1;
		throw new Error('Probe response lost');
	});
	client.lastSuccessfulRequestAt = 0;
	const backend = createBackend('active', client);
	backend.healthCheckFailures = 1;
	await createChecks(backend).runHealthChecks();
	expect(backend.healthCheckFailures).toBe(0);
});

test('disabled backends are not health checked', async () => {
	let pingCount = 0;
	const client = createClient(async () => {
		pingCount += 1;
		return {};
	});
	const backend = createBackend('disabled', client);
	backend.serverConfig.enabled = false;

	await createChecks(backend, () => undefined).runHealthChecks();
	expect(pingCount).toBe(0);
	expect(backend.healthCheckFailures).toBe(0);
});

test('an in-flight health check cannot affect a disabled or replaced backend', async () => {
	let releasePing = (): void => {
		throw new Error('Ping did not start');
	};
	let signalPingStarted = (): void => undefined;
	const pingStarted = new Promise<void>((resolve) => {
		signalPingStarted = resolve;
	});
	const pingPending = new Promise<Record<string, never>>((resolve) => {
		releasePing = () => resolve({});
	});
	const originalClient = createClient(async () => {
		signalPingStarted();
		return await pingPending;
	});
	let replacementPingCount = 0;
	const replacementClient = createClient(async () => {
		replacementPingCount += 1;
		return {};
	});
	const backend = createBackend('race', originalClient);
	let markedDown = 0;
	const checks = createChecks(backend, () => {
		markedDown += 1;
	});

	const runningCheck = checks.runHealthChecks();
	await pingStarted;
	backend.serverConfig.enabled = false;
	backend.healthCheckReady = false;
	backend.healthCheckFailures = 0;
	backend.client = undefined;
	backend.serverConfig.enabled = true;
	backend.client = replacementClient;
	backend.healthCheckReady = true;
	releasePing();
	await runningCheck;

	expect(markedDown).toBe(0);
	expect(backend.healthCheckFailures).toBe(0);
	expect(replacementPingCount).toBe(0);
});

test('enabled backends use bounded heartbeat timeouts and failure threshold', async () => {
	const observedTimeouts: Array<number | undefined> = [];
	const client = createClient(async (options) => {
		observedTimeouts.push(options.timeout);
		throw new Error('heartbeat failed');
	});
	const backend = createBackend('enabled', client);
	let markedDown = 0;
	const checks = createChecks(backend, () => {
		markedDown += 1;
	});

	await checks.runHealthChecks();
	expect(backend.healthCheckFailures).toBe(1);
	expect(markedDown).toBe(0);
	backend.serverConfig.timeout = 3000;
	await checks.runHealthChecks();
	expect(backend.healthCheckFailures).toBe(2);
	expect(markedDown).toBe(1);
	expect(observedTimeouts).toEqual([9000, 3000]);
});
