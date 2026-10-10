import { type } from 'arktype';

import type {
	Client,
	McpUpstreamBackend,
	OnValidationError,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import { pingResultType } from '@/shared/mcp_schemas';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = HEALTH_CHECK_INTERVAL_MS - 1000;
const HEALTH_CHECK_FAILURE_THRESHOLD = 2;
const HEALTH_CHECK_IDLE_MS = 60_000;

type CreateMcpUpstreamHealthChecksParams = {
	backends: Map<string, McpUpstreamBackend>;
	markMcpUpstreamDown: (backend: McpUpstreamBackend, error: string) => void;
	onValidationError: OnValidationError;
	waitForRateLimit: (backend: McpUpstreamBackend) => Promise<void>;
};

const createMcpUpstreamHealthChecks = (
	params: CreateMcpUpstreamHealthChecksParams,
) => {
	const { backends, markMcpUpstreamDown, onValidationError, waitForRateLimit } =
		params;
	let healthCheckTimer: Timer | null = null;
	let healthCheckRunning = false;

	const isCurrentHealthTarget = (
		backend: McpUpstreamBackend,
		client: Client,
	): boolean => {
		return (
			backend.serverConfig.enabled &&
			backend.healthCheckReady &&
			backend.client === client
		);
	};

	const checkMcpUpstreamHealth = async (
		backend: McpUpstreamBackend,
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
		if (!isCurrentHealthTarget(backend, client))
			return {
				state: 'stale',
			};

		const start = Date.now();
		const timeout = Math.min(
			backend.serverConfig.timeout,
			HEALTH_CHECK_TIMEOUT_MS,
		);
		try {
			await waitForRateLimit(backend);
			if (!isCurrentHealthTarget(backend, client))
				return {
					state: 'stale',
				};
			const result = await client.ping({
				timeout,
			});
			if (!isCurrentHealthTarget(backend, client))
				return {
					state: 'stale',
				};
			const parsed = pingResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server: backend,
					method: 'ping',
					error: parsed,
				});
			}
			return {
				state: 'healthy',
			};
		} catch (err) {
			if (!isCurrentHealthTarget(backend, client))
				return {
					state: 'stale',
				};
			if (client.lastSuccessfulRequestAt >= start)
				return {
					state: 'healthy',
				};
			const elapsed = Date.now() - start;
			return {
				state: 'unhealthy',
				error: `${errorMessage(err)} (elapsed: ${elapsed}ms, timeout: ${timeout}ms)`,
			};
		}
	};

	const runHealthChecks = async (): Promise<void> => {
		const readyBackends = Array.from(backends.values()).filter(
			(backend) => backend.healthCheckReady,
		);
		await Promise.all(
			readyBackends.map(async (backend) => {
				const serverName = backend.serverName;
				const client = backend.client;
				if (!client) return;
				// Any successful RPC proves reachability; busy backends need no ping.
				if (
					Date.now() - client.lastSuccessfulRequestAt <
					HEALTH_CHECK_IDLE_MS
				) {
					backend.healthCheckFailures = 0;
					return;
				}

				const result = await checkMcpUpstreamHealth(backend, client);
				if (
					!isCurrentHealthTarget(backend, client) ||
					result.state === 'stale'
				) {
					return;
				}
				if (result.state === 'healthy') {
					const previousFailures = backend.healthCheckFailures;
					if (previousFailures > 0) {
						logger.info(
							`MCP upstream "${serverName}" health check recovered after ${previousFailures} failed check(s)`,
						);
						backend.healthCheckFailures = 0;
					}
					return;
				}

				const failures = backend.healthCheckFailures + 1;
				backend.healthCheckFailures = failures;

				if (failures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
					logger.error(
						`MCP upstream "${serverName}" failed ${failures} consecutive health check(s); marking down: ${result.error}`,
					);
					markMcpUpstreamDown(backend, `Health check failed: ${result.error}`);
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
