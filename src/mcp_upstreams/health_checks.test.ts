import { createMcpUpstreamHealthChecks } from '@/mcp_upstreams/health_checks';
import type { ProtocolClient as Client } from '@/mcp_upstreams/protocol_client';
import type {
	McpUpstreamClientsMap,
	McpUpstreamServer,
} from '@/mcp_upstreams/types';

import { expect, spyOn, test } from 'bun:test';

test('successful traffic suppresses idle pings and clears old failures', async () => {
	const now = spyOn(Date, 'now').mockReturnValue(100_000);
	const server = createServer('active');
	let pings = 0;
	const client = createClient(async () => {
		pings += 1;
		client.lastSuccessfulRequestAt = Date.now();
		return {};
	});
	client.lastSuccessfulRequestAt = 99_000;
	const failures = new Map([
		[
			'active',
			1,
		],
	]);
	const checks = createMcpUpstreamHealthChecks({
		clients: new Map([
			[
				'active',
				client,
			],
		]),
		getServer: () => server,
		healthCheckFailures: failures,
		healthCheckReadyBackends: new Set([
			'active',
		]),
		markMcpUpstreamDown: () => {
			throw new Error('Unexpected down');
		},
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});
	try {
		await checks.runHealthChecks();
		expect(pings).toBe(0);
		expect(failures.size).toBe(0);
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
	const server = createServer('active');
	const client = createClient(async () => {
		client.lastSuccessfulRequestAt = Date.now() + 1;
		throw new Error('Probe response lost');
	});
	client.lastSuccessfulRequestAt = 0;
	const failures = new Map([
		[
			'active',
			1,
		],
	]);
	const checks = createMcpUpstreamHealthChecks({
		clients: new Map([
			[
				'active',
				client,
			],
		]),
		getServer: () => server,
		healthCheckFailures: failures,
		healthCheckReadyBackends: new Set([
			'active',
		]),
		markMcpUpstreamDown: () => {
			throw new Error('Unexpected down');
		},
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});
	await checks.runHealthChecks();
	expect(failures.size).toBe(0);
});

const createServer = (serverName: string): McpUpstreamServer => ({
	serverName,
	serverConfig: {
		type: 'http',
		url: `http://127.0.0.1/${serverName}`,
		enabled: true,
		timeout: 10_000,
		trafficLimit: 1,
	},
});

const createClient = (
	ping: (options: { timeout?: number }) => Promise<Record<string, never>>,
): Client =>
	({
		ping,
	}) as unknown as Client;

test('disabled backends are not health checked', async () => {
	const server = createServer('disabled');
	server.serverConfig.enabled = false;
	let pingCount = 0;
	const client = createClient(async () => {
		pingCount += 1;
		return {};
	});
	const clients: McpUpstreamClientsMap = new Map([
		[
			'disabled',
			client,
		],
	]);
	const healthCheckReadyBackends = new Set([
		'disabled',
	]);
	const healthCheckFailures = new Map<string, number>();
	const checks = createMcpUpstreamHealthChecks({
		clients,
		getServer: () => server,
		healthCheckFailures,
		healthCheckReadyBackends,
		markMcpUpstreamDown: () => undefined,
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});

	await checks.runHealthChecks();
	expect(pingCount).toBe(0);
	expect(healthCheckFailures.size).toBe(0);
});

test('an in-flight health check cannot affect a disabled or replaced backend', async () => {
	const server = createServer('race');
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
	const clients: McpUpstreamClientsMap = new Map([
		[
			'race',
			originalClient,
		],
	]);
	const healthCheckReadyBackends = new Set([
		'race',
	]);
	const healthCheckFailures = new Map<string, number>();
	let markedDown = 0;
	const checks = createMcpUpstreamHealthChecks({
		clients,
		getServer: () => server,
		healthCheckFailures,
		healthCheckReadyBackends,
		markMcpUpstreamDown: () => {
			markedDown += 1;
		},
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});

	const runningCheck = checks.runHealthChecks();
	await pingStarted;
	server.serverConfig.enabled = false;
	healthCheckReadyBackends.delete('race');
	healthCheckFailures.delete('race');
	clients.delete('race');
	server.serverConfig.enabled = true;
	clients.set('race', replacementClient);
	healthCheckReadyBackends.add('race');
	releasePing();
	await runningCheck;

	expect(markedDown).toBe(0);
	expect(healthCheckFailures.size).toBe(0);
	expect(replacementPingCount).toBe(0);
});

test('enabled backends use bounded heartbeat timeouts and failure threshold', async () => {
	const server = createServer('enabled');
	const observedTimeouts: Array<number | undefined> = [];
	const client = createClient(async (options) => {
		observedTimeouts.push(options.timeout);
		throw new Error('heartbeat failed');
	});
	const clients: McpUpstreamClientsMap = new Map([
		[
			'enabled',
			client,
		],
	]);
	const healthCheckReadyBackends = new Set([
		'enabled',
	]);
	const healthCheckFailures = new Map<string, number>();
	let markedDown = 0;
	const checks = createMcpUpstreamHealthChecks({
		clients,
		getServer: () => server,
		healthCheckFailures,
		healthCheckReadyBackends,
		markMcpUpstreamDown: () => {
			markedDown += 1;
		},
		onValidationError: () => undefined,
		waitForRateLimit: async () => undefined,
	});

	await checks.runHealthChecks();
	expect(healthCheckFailures.get('enabled')).toBe(1);
	expect(markedDown).toBe(0);
	server.serverConfig.timeout = 3000;
	await checks.runHealthChecks();
	expect(healthCheckFailures.get('enabled')).toBe(2);
	expect(markedDown).toBe(1);
	expect(observedTimeouts).toEqual([
		9000,
		3000,
	]);
});
