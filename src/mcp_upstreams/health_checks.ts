import type { Client } from '@modelcontextprotocol/sdk/client';
import { type } from 'arktype';

import type {
	McpUpstreamClientsMap,
	McpUpstreamServer,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import { pingResultType } from '@/shared/mcp_schemas';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = HEALTH_CHECK_INTERVAL_MS - 1000;
const HEALTH_CHECK_FAILURE_THRESHOLD = 2;

type OnValidationError = (params: {
	server: McpUpstreamServer;
	method: string;
	error: type.errors;
	request?: unknown;
}) => void;

type CreateMcpUpstreamHealthChecksParams = {
	clients: McpUpstreamClientsMap;
	getServer: (serverName: string) => McpUpstreamServer | undefined;
	healthCheckFailures: Map<string, number>;
	healthCheckReadyBackends: Set<string>;
	markMcpUpstreamDown: (server: McpUpstreamServer, error: string) => void;
	onValidationError: OnValidationError;
	waitForRateLimit: (server: McpUpstreamServer) => Promise<void>;
};

const createMcpUpstreamHealthChecks = (
	params: CreateMcpUpstreamHealthChecksParams,
) => {
	const {
		clients,
		getServer,
		healthCheckFailures,
		healthCheckReadyBackends,
		markMcpUpstreamDown,
		onValidationError,
		waitForRateLimit,
	} = params;
	let healthCheckTimer: Timer | null = null;
	let healthCheckRunning = false;

	const isCurrentHealthTarget = (
		server: McpUpstreamServer,
		client: Client,
	): boolean => {
		return (
			server.serverConfig.enabled &&
			healthCheckReadyBackends.has(server.serverName) &&
			clients.get(server.serverName) === client
		);
	};

	const checkMcpUpstreamHealth = async (
		server: McpUpstreamServer,
		client: Client,
	): Promise<
		| {
				state: 'healthy';
		  }
		| {
				state: 'unhealthy';
				error: string;
		  }
		| {
				state: 'stale';
		  }
	> => {
		if (!isCurrentHealthTarget(server, client))
			return {
				state: 'stale',
			};

		const start = Date.now();
		const timeout = Math.min(
			server.serverConfig.timeout,
			HEALTH_CHECK_TIMEOUT_MS,
		);
		try {
			await waitForRateLimit(server);
			if (!isCurrentHealthTarget(server, client))
				return {
					state: 'stale',
				};
			const result = await client.ping({
				timeout,
			});
			if (!isCurrentHealthTarget(server, client))
				return {
					state: 'stale',
				};
			const parsed = pingResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server,
					method: 'ping',
					error: parsed,
				});
			}
			return {
				state: 'healthy',
			};
		} catch (err) {
			if (!isCurrentHealthTarget(server, client))
				return {
					state: 'stale',
				};
			const elapsed = Date.now() - start;
			return {
				state: 'unhealthy',
				error: `${errorMessage(err)} (elapsed: ${elapsed}ms, timeout: ${timeout}ms)`,
			};
		}
	};

	const runHealthChecks = async (): Promise<void> => {
		const readyServerNames = Array.from(healthCheckReadyBackends);
		await Promise.all(
			readyServerNames.map(async (serverName) => {
				const server = getServer(serverName);
				const client = clients.get(serverName);
				if (!server || !client) return;

				const result = await checkMcpUpstreamHealth(server, client);
				if (
					!isCurrentHealthTarget(server, client) ||
					result.state === 'stale'
				) {
					return;
				}
				if (result.state === 'healthy') {
					const previousFailures = healthCheckFailures.get(serverName) ?? 0;
					if (previousFailures > 0) {
						logger.info(
							`MCP upstream "${serverName}" health check recovered after ${previousFailures} failed check(s)`,
						);
						healthCheckFailures.delete(serverName);
					}
					return;
				}

				const failures = (healthCheckFailures.get(serverName) ?? 0) + 1;
				healthCheckFailures.set(serverName, failures);

				if (failures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
					logger.error(
						`MCP upstream "${serverName}" failed ${failures} consecutive health check(s); marking down: ${result.error}`,
					);
					markMcpUpstreamDown(server, `Health check failed: ${result.error}`);
					return;
				}
				logger.warn(
					`Health check failed for MCP upstream "${serverName}" (${failures}/${HEALTH_CHECK_FAILURE_THRESHOLD}): ${result.error}`,
				);
			}),
		);
	};

	const startHealthChecks = (): void => {
		if (healthCheckTimer) return;
		healthCheckTimer = setInterval(async () => {
			if (healthCheckRunning) return;
			healthCheckRunning = true;
			try {
				await runHealthChecks();
			} catch (err) {
				logger.error(`MCP upstream health check failed: ${errorMessage(err)}`);
			} finally {
				healthCheckRunning = false;
			}
		}, HEALTH_CHECK_INTERVAL_MS);
	};

	const stopHealthChecks = (): void => {
		if (!healthCheckTimer) return;
		clearInterval(healthCheckTimer);
		healthCheckTimer = null;
	};

	return {
		runHealthChecks,
		startHealthChecks,
		stopHealthChecks,
	};
};

export { createMcpUpstreamHealthChecks };
