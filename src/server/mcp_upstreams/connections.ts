import { logger } from '@/server/logger';
import { createMcpUpstreamHealthChecks } from '@/server/mcp_upstreams/health_checks';
import {
	isAuthenticationError,
	ProtocolClient,
	ProtocolNegotiationError,
} from '@/server/mcp_upstreams/protocol_client';
import type {
	McpUpstreamBackend,
	McpUpstreamErrorState,
	McpUpstreamServer,
	McpUpstreamStatus,
	OnValidationError,
} from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/shared/mcp_protocol';

const RECONNECT_INITIAL_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MIN_INTERVAL_MS = 1000;

type CreateMcpUpstreamConnectionsParams = {
	backends: Map<string, McpUpstreamBackend>;
	trafficStore?: TrafficStore;
	refreshCatalog: (backend: McpUpstreamBackend) => Promise<void>;
};

const createMcpUpstreamBackend = (
	server: McpUpstreamServer,
): McpUpstreamBackend => ({
	...server,
	epoch: 0,
	configError: false,
	protocolError: false,
	probing: false,
	reconnectAttempts: 0,
	healthCheckReady: false,
	healthCheckFailures: 0,
	lastRequestTime: 0,
	listExpiresAt: {
		tools: 0,
		prompts: 0,
		resources: 0,
		resourceTemplates: 0,
	},
	listRefreshes: {},
});

const transportFields = (
	config: McpUpstreamServer['serverConfig'],
):
	| {
			type: 'http';
			url: string;
	  }
	| {
			type: 'stdio';
			command: string;
	  } => {
	if (config.type === 'stdio') {
		return {
			type: 'stdio',
			command: config.command,
		};
	}
	return {
		type: 'http',
		url: config.url,
	};
};

const createMcpUpstreamConnections = (
	params: CreateMcpUpstreamConnectionsParams,
) => {
	const { backends, trafficStore, refreshCatalog } = params;
	let stopped = false;
	const isConnectionBlocked = (backend: McpUpstreamBackend): boolean =>
		backend.configError || backend.protocolError;

	const isActive = (backend: McpUpstreamBackend): boolean =>
		backend.serverConfig.enabled || backend.probing;

	const isCurrentConnectionAttempt = (
		backend: McpUpstreamBackend,
		epoch: number,
	): boolean => {
		return !stopped && isActive(backend) && backend.epoch === epoch;
	};

	const setMcpUpstreamStatus = (statusParams: {
		backend: McpUpstreamBackend;
		connected: boolean;
		error?: string;
		errorState?: McpUpstreamErrorState;
		actionRequired?: boolean;
	}): void => {
		const backend = statusParams.backend;
		const existing = backend.status;
		backend.status = {
			serverName: backend.serverName,
			protocolVersion: backend.protocolVersion,
			...transportFields(backend.serverConfig),
			enabled: backend.serverConfig.enabled,
			enabledTools: backend.serverConfig.enabledTools ?? [],
			availableTools: backend.serverConfig.availableTools ?? [],
			connected: statusParams.connected,
			error: statusParams.error,
			errorState: statusParams.errorState,
			actionRequired: statusParams.actionRequired,
			implementation: existing?.implementation,
			capabilities: existing?.capabilities,
			instructions: existing?.instructions,
		};
	};

	const getBackend = (serverName: string): McpUpstreamBackend | undefined => {
		return backends.get(serverName);
	};

	const closeMcpUpstreamConnection = async (
		backend: McpUpstreamBackend,
		logErrors = false,
	): Promise<void> => {
		backend.healthCheckReady = false;
		const client = backend.client;
		if (!client) return;
		client.onerror = () => undefined;
		client.ontransporterror = () => undefined;
		backend.client = undefined;
		// ProtocolClient owns its transport; closing the client releases both.
		await client.close().catch((error: unknown) => {
			if (logErrors)
				logger.error(
					`Error closing MCP upstream client for "${backend.serverName}": ${errorMessage(error)}`,
				);
		});
	};

	const waitForRateLimit = async (
		backend: McpUpstreamBackend,
		signal?: AbortSignal,
	): Promise<void> => {
		signal?.throwIfAborted();
		const minInterval = MIN_INTERVAL_MS / backend.serverConfig.trafficLimit;
		const previous = backend.lastRequestTime;
		// Reserve the slot before sleeping, so concurrent requests are spaced.
		const slot = Math.max(Date.now(), previous + minInterval);
		backend.lastRequestTime = slot;
		const waitTime = slot - Date.now();
		if (waitTime <= 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: () => void = () => undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(resolve, waitTime);
				abort = () => reject(signal?.reason);
				signal?.addEventListener('abort', abort, {
					once: true,
				});
			});
		} catch (error) {
			// A cancelled wait frees its slot unless a later request queued behind it.
			if (backend.lastRequestTime === slot) backend.lastRequestTime = previous;
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
		}
	};

	const onValidationError: OnValidationError = (validationParams): void => {
		const method = validationParams.method;
		const serverName = validationParams.server.serverName;
		logger.warn(`Response validation failed for "${serverName}" (${method})`);
		trafficStore?.logBackendTraffic({
			backend: serverName,
			method: `${method}:validation_error`,
			request: validationParams.request ?? {},
			response: {
				error: {
					type: 'response_validation_error',
					method,
					message: `${validationParams.error}`,
					issues: Array.from(validationParams.error),
				},
			},
		});
	};

	const setMcpUpstreamStatusError = (
		backend: McpUpstreamBackend,
		error: string,
	): void => {
		if (!isActive(backend)) return;
		const status = backend.status;
		if (!status) {
			setMcpUpstreamStatus({
				backend,
				connected: true,
				error,
				errorState: 'runtime',
				actionRequired: false,
			});
			return;
		}
		backend.status = {
			...status,
			error,
			errorState: 'runtime',
			actionRequired: false,
		};
	};

	const clearReconnectTimer = (backend: McpUpstreamBackend): void => {
		clearTimeout(backend.reconnectTimer);
		backend.reconnectTimer = undefined;
	};

	const scheduleReconnect = (backend: McpUpstreamBackend): void => {
		if (stopped) return;
		if (!backend.serverConfig.enabled) return;
		if (isConnectionBlocked(backend)) return;
		if (backend.reconnectTimer) return;

		const attempt = backend.reconnectAttempts;
		const ceiling = Math.min(
			RECONNECT_MAX_DELAY_MS,
			RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempt + 1, 4),
		);
		const delay = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
		backend.reconnectAttempts = attempt + 1;
		backend.reconnectTimer = setTimeout(() => {
			backend.reconnectTimer = undefined;
			void attemptReconnect(backend);
		}, delay);
		logger.info(
			JSON.stringify({
				message: 'Scheduled MCP upstream recovery',
				context: {
					backend: backend.serverName,
					attempt: attempt + 1,
					retryAfterMs: delay,
				},
			}),
		);
	};

	const markMcpUpstreamDown = (
		backend: McpUpstreamBackend,
		error: string,
	): void => {
		if (stopped) return;
		if (!backend.serverConfig.enabled) return;
		if (isConnectionBlocked(backend)) return;

		const existingStatus = backend.status;
		if (existingStatus && !existingStatus.connected && !backend.client) {
			if (existingStatus.error !== error) {
				backend.status = {
					...existingStatus,
					error,
				};
			}
			scheduleReconnect(backend);
			return;
		}

		backend.healthCheckFailures = 0;
		backend.healthCheckReady = false;
		void closeMcpUpstreamConnection(backend, true);
		setMcpUpstreamStatus({
			backend,
			connected: false,
			error,
			errorState: 'runtime',
			actionRequired: false,
		});
		logger.warn(
			`MCP upstream "${backend.serverName}" marked as down: ${error}`,
		);
		scheduleReconnect(backend);
	};

	const markMcpUpstreamConfigurationError = (
		backend: McpUpstreamBackend,
		error: string,
	): void => {
		if (!isActive(backend)) return;
		backend.configError = true;
		backend.healthCheckFailures = 0;
		backend.healthCheckReady = false;
		clearReconnectTimer(backend);

		void closeMcpUpstreamConnection(backend);
		setMcpUpstreamStatus({
			backend,
			connected: false,
			error,
			errorState: 'configuration',
			actionRequired: true,
		});
		logger.warn(
			`MCP upstream "${backend.serverName}" requires configuration fix: ${error}`,
		);
	};

	const openMcpUpstreamConnection = async (
		backend: McpUpstreamBackend,
	): Promise<boolean> => {
		const serverName = backend.serverName;
		if (stopped) return false;
		if (!isActive(backend)) return false;
		if (isConnectionBlocked(backend)) return false;
		const connectionEpoch = backend.epoch;

		const serverConfig = backend.serverConfig;
		await closeMcpUpstreamConnection(backend);
		if (!isCurrentConnectionAttempt(backend, connectionEpoch)) return false;
		const client = new ProtocolClient(backend, backend.protocolVersion);
		backend.connectingClient = client;
		client.ontransporterror = (error: unknown): void => {
			if (backend.client !== client) return;
			markMcpUpstreamDown(backend, errorMessage(error));
		};

		client.onerror = (err: unknown) => {
			const code = (
				err as {
					code?: number;
				}
			).code;
			const prefix = typeof code === 'number' ? `[${code}] ` : '';
			logger.warn(
				`MCP upstream client error for "${serverName}": ${prefix}${errorMessage(err)}`,
			);
		};

		try {
			await client.connect();
			if (!isCurrentConnectionAttempt(backend, connectionEpoch)) {
				client.onerror = () => undefined;
				await client.close().catch(() => undefined);
				return false;
			}
			backend.client = client;
			if (client.protocolVersion)
				backend.protocolVersion = client.protocolVersion;
			backend.healthCheckFailures = 0;

			const status: McpUpstreamStatus = {
				serverName,
				protocolVersion: backend.protocolVersion,
				...transportFields(serverConfig),
				enabled: serverConfig.enabled,
				enabledTools: serverConfig.enabledTools ?? [],
				availableTools: serverConfig.availableTools ?? [],
				connected: true,
				errorState: undefined,
				actionRequired: false,
				capabilities: client.getServerCapabilities(),
				implementation: client.getServerVersion(),
				instructions: client.getInstructions(),
				error: undefined,
			};
			backend.status = status;
			logger.info(`Connected to MCP upstream "${serverName}"`);
			return true;
		} catch (err) {
			if (!isCurrentConnectionAttempt(backend, connectionEpoch)) {
				client.onerror = () => undefined;
				await client.close().catch(() => undefined);
				return false;
			}
			const message = errorMessage(err);
			const protocolFailure = err instanceof ProtocolNegotiationError;
			if (protocolFailure) {
				// A failed negotiation needs operator attention, not a reconnect loop.
				backend.protocolError = true;
				clearReconnectTimer(backend);
			}
			logger.error(
				JSON.stringify({
					message: 'Failed to connect to MCP upstream',
					context: {
						backend: serverName,
						transport: serverConfig.type,
						...(err instanceof ProtocolNegotiationError ? err.context : {}),
						supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
						...(protocolFailure
							? {
									retry: 'stopped',
									recovery: 'Disable and re-enable the backend to retry',
								}
							: {
									retry: 'automatic with backoff',
								}),
					},
					error: message,
				}),
			);
			setMcpUpstreamStatus({
				backend,
				connected: false,
				error: message,
				errorState: protocolFailure
					? 'protocol'
					: isAuthenticationError(err)
						? 'authentication'
						: 'runtime',
				actionRequired: protocolFailure,
			});
			await client.close().catch(() => undefined);
			return false;
		} finally {
			if (backend.connectingClient === client)
				backend.connectingClient = undefined;
		}
	};

	const connectToMcpUpstream = async (
		backend: McpUpstreamBackend,
	): Promise<boolean> => {
		const epoch = backend.epoch;
		const pending = backend.connectionAttempt;
		if (pending?.epoch === epoch) return pending.promise;
		const promise = openMcpUpstreamConnection(backend);
		backend.connectionAttempt = {
			epoch,
			promise,
		};
		try {
			return await promise;
		} finally {
			if (backend.connectionAttempt?.promise === promise)
				backend.connectionAttempt = undefined;
		}
	};

	// Connect, load the catalog, then hand the backend to health checks.
	// Returns false when the backend is down, blocked or changed meanwhile.
	const bringUp = async (backend: McpUpstreamBackend): Promise<boolean> => {
		const epoch = backend.epoch;
		const connected = await connectToMcpUpstream(backend);
		if (!isCurrentConnectionAttempt(backend, epoch)) return false;
		if (!connected) {
			scheduleReconnect(backend);
			return false;
		}
		const client = backend.client;
		await refreshCatalog(backend);
		if (
			!isCurrentConnectionAttempt(backend, epoch) ||
			isConnectionBlocked(backend) ||
			!client ||
			backend.client !== client
		)
			return false;
		backend.healthCheckReady = true;
		backend.reconnectAttempts = 0;
		return true;
	};

	// Re-read the backend's server info, capabilities and instructions. A
	// failure keeps the current details; the catalog refresh reports outages.
	const refreshDetails = async (backend: McpUpstreamBackend): Promise<void> => {
		const client = backend.client;
		if (!client) return;
		try {
			await waitForRateLimit(backend);
			await client.rediscover();
		} catch (error) {
			logger.warn(
				`Failed to refresh details for MCP upstream "${backend.serverName}": ${errorMessage(error)}`,
			);
			return;
		}
		if (backend.client !== client || !backend.status) return;
		backend.status = {
			...backend.status,
			capabilities: client.getServerCapabilities(),
			implementation: client.getServerVersion(),
			instructions: client.getInstructions(),
		};
	};

	const attemptReconnect = async (
		backend: McpUpstreamBackend,
	): Promise<void> => {
		if (stopped) return;
		if (!backend.serverConfig.enabled) return;
		if (isConnectionBlocked(backend)) return;
		const epoch = backend.epoch;
		const pending = backend.reconnect;
		if (pending?.epoch === epoch) return pending.promise;
		if (backend.client) return;
		clearReconnectTimer(backend);
		const recover = async (): Promise<void> => {
			try {
				if (!(await bringUp(backend))) return;
				logger.info(
					JSON.stringify({
						message: 'MCP upstream recovered',
						context: {
							backend: backend.serverName,
						},
					}),
				);
			} catch (error) {
				if (!isCurrentConnectionAttempt(backend, epoch)) return;
				markMcpUpstreamDown(backend, errorMessage(error));
			}
		};
		const promise = recover();
		backend.reconnect = {
			epoch,
			promise,
		};
		try {
			await promise;
		} finally {
			if (backend.reconnect?.promise === promise) backend.reconnect = undefined;
			if (isCurrentConnectionAttempt(backend, epoch) && !backend.client)
				scheduleReconnect(backend);
		}
	};

	const healthChecks = createMcpUpstreamHealthChecks({
		backends,
		markMcpUpstreamDown,
		onValidationError,
		waitForRateLimit,
	});

	const setBackendEnabled = async (
		backend: McpUpstreamBackend,
		enabled: boolean,
	): Promise<void> => {
		const serverName = backend.serverName;
		backend.epoch += 1;
		clearReconnectTimer(backend);
		backend.reconnectAttempts = 0;
		await backend.connectingClient?.close().catch(() => undefined);
		backend.serverConfig.enabled = enabled;
		backend.protocolError = false;
		backend.configError = false;

		if (!enabled) {
			backend.healthCheckReady = false;
			backend.healthCheckFailures = 0;
			backend.lastRequestTime = 0;
			await closeMcpUpstreamConnection(backend, true);
			setMcpUpstreamStatus({
				backend,
				connected: false,
				actionRequired: false,
			});
			logger.info(`Disabled MCP upstream "${serverName}"`);
			return;
		}

		setMcpUpstreamStatus({
			backend,
			connected: false,
			actionRequired: false,
		});
		if (await bringUp(backend))
			logger.info(`Enabled MCP upstream "${serverName}"`);
	};

	const probe = async (backend: McpUpstreamBackend): Promise<void> => {
		const epoch = backend.epoch;
		backend.probing = true;
		try {
			if (await connectToMcpUpstream(backend)) await refreshCatalog(backend);
		} finally {
			backend.probing = false;
		}
		if (backend.epoch !== epoch) return;
		await closeMcpUpstreamConnection(backend);
		setMcpUpstreamStatus({
			backend,
			connected: false,
			error: backend.status?.error,
			errorState: backend.status?.errorState,
			actionRequired: backend.status?.actionRequired,
		});
	};

	const initialize = async (): Promise<void> => {
		stopped = false;
		const allBackends = Array.from(backends.values());
		for (const backend of allBackends)
			setMcpUpstreamStatus({
				backend,
				connected: false,
				actionRequired: false,
			});
		const results = await Promise.allSettled(
			allBackends.map((backend) =>
				backend.serverConfig.enabled ? bringUp(backend) : probe(backend),
			),
		);
		results.forEach((result, index) => {
			if (result.status === 'fulfilled') return;
			logger.warn(
				`MCP upstream "${allBackends[index]?.serverName}" connection failed: ${result.reason}`,
			);
		});
		if (!stopped) healthChecks.startHealthChecks();
	};

	const disconnect = async (): Promise<void> => {
		stopped = true;
		healthChecks.stopHealthChecks();
		for (const backend of backends.values()) {
			backend.healthCheckReady = false;
			backend.healthCheckFailures = 0;
			backend.epoch += 1;
			clearReconnectTimer(backend);
			backend.reconnectAttempts = 0;
			backend.lastRequestTime = 0;
		}
		await Promise.all(
			Array.from(backends.values(), async (backend) => {
				await backend.connectingClient?.close().catch(() => undefined);
				backend.connectingClient = undefined;
			}),
		);

		for (const backend of backends.values()) {
			await closeMcpUpstreamConnection(backend, true);
			backend.tools = undefined;
			backend.prompts = undefined;
			backend.resources = undefined;
			backend.resourceTemplates = undefined;
			setMcpUpstreamStatus({
				backend,
				connected: false,
				error: 'Disconnected',
				errorState: 'runtime',
				actionRequired: false,
			});
		}
	};

	const getStatuses = (): McpUpstreamStatus[] =>
		Array.from(backends.values()).flatMap((backend) =>
			backend.status
				? [
						{
							...backend.status,
							enabled: backend.serverConfig.enabled,
							enabledTools: backend.serverConfig.enabledTools ?? [],
							availableTools: backend.serverConfig.availableTools ?? [],
						},
					]
				: [],
		);

	return {
		attemptReconnect,
		disconnect,
		getBackend,
		getStatuses,
		initialize,
		markMcpUpstreamConfigurationError,
		onValidationError,
		refreshDetails,
		setMcpUpstreamStatusError,
		setBackendEnabled,
		waitForRateLimit,
	};
};

export { createMcpUpstreamBackend, createMcpUpstreamConnections };
