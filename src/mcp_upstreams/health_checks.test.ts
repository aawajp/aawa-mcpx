import { createMcpUpstreamHealthChecks } from '@/mcp_upstreams/health_checks';
import type { ProtocolClient as Client } from '@/mcp_upstreams/protocol_client';
import type {
	McpUpstreamClientsMap,
	McpUpstreamServer,
} from '@/mcp_upstreams/types';

import { expect, test } from 'bun:test';

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
