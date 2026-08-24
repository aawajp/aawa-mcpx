import { Client } from '@modelcontextprotocol/sdk/client';
import type { type } from 'arktype';

import { createMcpUpstreamHealthChecks } from '@/mcp_upstreams/health_checks';
import {
	createMcpUpstreamTransport,
	type McpUpstreamTransport,
} from '@/mcp_upstreams/transport';
import type {
	GetClientParams,
	McpUpstreamClientsMap,
	McpUpstreamErrorState,
	McpUpstreamPromptsMap,
	McpUpstreamRequestQueue,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamStatus,
	McpUpstreamToolsMap,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

const RECONNECT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const CLOSE_ERROR_SUPPRESSION_MS = 10_000;

type OnValidationError = (params: {
	server: McpUpstreamServer;
	method: string;
	error: type.errors;
	request?: unknown;
}) => void;

type CreateMcpUpstreamConnectionsParams = {
	clients: McpUpstreamClientsMap;
	configErrorBackends: Set<string>;
	healthCheckFailures: Map<string, number>;
	promptsCache: McpUpstreamPromptsMap;
	reconnectTimers: Map<string, Timer>;
	requestQueues: Map<string, McpUpstreamRequestQueue>;
	resourcesCache: McpUpstreamResourcesMap;
	servers: Map<string, McpUpstreamServer>;
	statuses: Map<string, McpUpstreamStatus>;
	suppressClientErrorsUntil: Map<string, number>;
	toolsCache: McpUpstreamToolsMap;
	trafficStore?: TrafficStore;
	transports: Map<string, McpUpstreamTransport>;
	refreshCatalog: (server: McpUpstreamServer) => Promise<void>;
};

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

const isAbortLikeError = (err: unknown): boolean => {
	const name = (err as Error).name;
	const message = errorMessage(err);
	return (
		name === 'AbortError' ||
		message.includes('The operation was aborted') ||
		message.includes('Failed to send cancellation')
	);
};

const createMcpUpstreamConnections = (
	params: CreateMcpUpstreamConnectionsParams,
) => {
	const {
		clients,
		configErrorBackends,
		healthCheckFailures,
		promptsCache,
		reconnectTimers,
		requestQueues,
		resourcesCache,
		servers,
		statuses,
		suppressClientErrorsUntil,
		toolsCache,
		trafficStore,
		transports,
		refreshCatalog,
	} = params;
	const healthCheckReadyBackends = new Set<string>();
	const connectionEpochs = new Map<string, number>();

	const advanceConnectionEpoch = (serverName: string): void => {
		connectionEpochs.set(
			serverName,
			(connectionEpochs.get(serverName) ?? 0) + 1,
		);
	};

	const isCurrentConnectionAttempt = (
		server: McpUpstreamServer,
		epoch: number,
	): boolean => {
		return (
			server.serverConfig.enabled &&
			(connectionEpochs.get(server.serverName) ?? 0) === epoch
		);
	};

	const setMcpUpstreamStatus = (statusParams: {
		server: McpUpstreamServer;
		connected: boolean;
		error?: string;
		errorState?: McpUpstreamErrorState;
		actionRequired?: boolean;
		preserveDetails?: boolean;
	}): void => {
		const serverName = statusParams.server.serverName;
		const existing = statuses.get(serverName);
		const preserveDetails = statusParams.preserveDetails ?? true;
		const next: McpUpstreamStatus = {
			serverName,
			...transportFields(statusParams.server.serverConfig),
			enabled: statusParams.server.serverConfig.enabled,
			enabledTools: statusParams.server.serverConfig.enabledTools ?? [],
			connected: statusParams.connected,
			error: statusParams.error,
			errorState: statusParams.errorState,
			actionRequired: statusParams.actionRequired,
			implementation: preserveDetails ? existing?.implementation : undefined,
			capabilities: preserveDetails ? existing?.capabilities : undefined,
			instructions: preserveDetails ? existing?.instructions : undefined,
		};
		statuses.set(serverName, next);
	};

	const getServer = (serverName: string): McpUpstreamServer | undefined => {
		return servers.get(serverName);
	};

	const suppressClientErrors = (server: McpUpstreamServer): void => {
		suppressClientErrorsUntil.set(
			server.serverName,
			Date.now() + CLOSE_ERROR_SUPPRESSION_MS,
		);
	};

	const shouldSuppressClientError = (server: McpUpstreamServer): boolean => {
		const until = suppressClientErrorsUntil.get(server.serverName);
		if (!until) return false;
		if (Date.now() <= until) return true;
		suppressClientErrorsUntil.delete(server.serverName);
		return false;
	};

	const closeMcpUpstreamConnection = async (
		server: McpUpstreamServer,
		logErrors = false,
	): Promise<void> => {
		const serverName = server.serverName;
		healthCheckReadyBackends.delete(serverName);
		const existingClient = clients.get(serverName);
		const existingTransport = transports.get(serverName);
		if (!existingClient && !existingTransport) return;

		suppressClientErrors(server);

		const closeTasks: Promise<void>[] = [];
		if (existingClient) {
			existingClient.onerror = () => undefined;
			clients.delete(serverName);
			closeTasks.push(
				existingClient.close().catch((err: unknown) => {
					if (logErrors) {
						logger.error(
							`Error closing MCP upstream client for "${serverName}": ${errorMessage(err)}`,
						);
					}
				}),
			);
		}
		if (existingTransport) {
			transports.delete(serverName);
			closeTasks.push(
				existingTransport.close().catch((err: unknown) => {
					if (logErrors) {
						logger.error(
							`Error closing MCP upstream transport for "${serverName}": ${errorMessage(err)}`,
						);
					}
				}),
			);
		}

		await Promise.all(closeTasks);
	};

	const getOrCreateQueue = (
		server: McpUpstreamServer,
	): McpUpstreamRequestQueue => {
		const serverName = server.serverName;
		let queue = requestQueues.get(serverName);
		if (!queue) {
			queue = {
				pending: [],
				isProcessing: false,
				lastRequestTime: 0,
			};
			requestQueues.set(serverName, queue);
		}
		return queue;
	};

	const waitForRateLimit = async (server: McpUpstreamServer): Promise<void> => {
		const queue = getOrCreateQueue(server);
		const now = Date.now();
		const trafficLimit = server.serverConfig.trafficLimit;
		const minInterval = MIN_INTERVAL_MS / trafficLimit;
		const timeSinceLastRequest = now - queue.lastRequestTime;

		if (timeSinceLastRequest < minInterval) {
			const waitTime = minInterval - timeSinceLastRequest;
			await Bun.sleep(waitTime);
		}

		queue.lastRequestTime = Date.now();
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
		server: McpUpstreamServer,
		error: string,
	): void => {
		if (!server.serverConfig.enabled) return;
		const status = statuses.get(server.serverName);
		if (!status) {
			setMcpUpstreamStatus({
				server,
				connected: true,
				error,
				errorState: 'runtime',
				actionRequired: false,
			});
			return;
		}
		statuses.set(server.serverName, {
			...status,
			error,
			errorState: 'runtime',
			actionRequired: false,
		});
	};

	const scheduleReconnect = (server: McpUpstreamServer): void => {
		const serverName = server.serverName;
		if (!server.serverConfig.enabled) return;
		if (configErrorBackends.has(serverName)) return;
		if (reconnectTimers.has(serverName)) return;

		const timer = setTimeout(() => {
			reconnectTimers.delete(serverName);
			attemptReconnect(server);
		}, RECONNECT_INTERVAL_MS);
		reconnectTimers.set(serverName, timer);
	};

	const markMcpUpstreamDown = (
		server: McpUpstreamServer,
		error: string,
	): void => {
		const serverName = server.serverName;
		if (!server.serverConfig.enabled) return;
		if (configErrorBackends.has(serverName)) return;

		const existingStatus = statuses.get(serverName);
		const alreadyDown =
			existingStatus &&
			!existingStatus.connected &&
			!clients.has(serverName) &&
			!transports.has(serverName);
		if (alreadyDown) {
			if (existingStatus.error !== error) {
				statuses.set(serverName, {
					...existingStatus,
					error,
				});
			}
			return;
		}

		healthCheckFailures.delete(serverName);
		healthCheckReadyBackends.delete(serverName);
		void closeMcpUpstreamConnection(server, true);
		setMcpUpstreamStatus({
			server,
			connected: false,
			error,
			errorState: 'runtime',
			actionRequired: false,
		});
		logger.warn(`MCP upstream "${serverName}" marked as down: ${error}`);
		scheduleReconnect(server);
	};

	const markMcpUpstreamConfigurationError = (
		server: McpUpstreamServer,
		error: string,
	): void => {
		const serverName = server.serverName;
		if (!server.serverConfig.enabled) return;
		configErrorBackends.add(serverName);
		healthCheckFailures.delete(serverName);
		healthCheckReadyBackends.delete(serverName);

		const timer = reconnectTimers.get(serverName);
		if (timer) {
			clearTimeout(timer);
			reconnectTimers.delete(serverName);
		}

		void closeMcpUpstreamConnection(server);
		setMcpUpstreamStatus({
			server,
			connected: false,
			error,
			errorState: 'configuration',
			actionRequired: true,
		});
		logger.warn(
			`MCP upstream "${serverName}" requires configuration fix: ${error}`,
		);
	};

	const connectToMcpUpstream = async (
		server: McpUpstreamServer,
	): Promise<boolean> => {
		const serverName = server.serverName;
		if (!server.serverConfig.enabled) return false;
		if (configErrorBackends.has(serverName)) return false;
		const connectionEpoch = connectionEpochs.get(serverName) ?? 0;

		const serverConfig = server.serverConfig;
		await closeMcpUpstreamConnection(server);
		if (!isCurrentConnectionAttempt(server, connectionEpoch)) return false;
		const transport = createMcpUpstreamTransport(server);
		const client = new Client({
			name: `aawa-mcpx-${serverName}`,
			version: '1.0.0',
		});

		client.onerror = (err: unknown) => {
			if (shouldSuppressClientError(server) && isAbortLikeError(err)) return;
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
			await client.connect(transport, {
				timeout: serverConfig.timeout,
			});
			if (!isCurrentConnectionAttempt(server, connectionEpoch)) {
				client.onerror = () => undefined;
				await client.close().catch(() => undefined);
				await transport.close().catch(() => undefined);
				return false;
			}
			clients.set(serverName, client);
			transports.set(serverName, transport);
			healthCheckFailures.delete(serverName);
			suppressClientErrorsUntil.delete(serverName);

			const status: McpUpstreamStatus = {
				serverName,
				...transportFields(serverConfig),
				enabled: serverConfig.enabled,
				enabledTools: serverConfig.enabledTools ?? [],
				connected: true,
				errorState: undefined,
				actionRequired: false,
				capabilities: client.getServerCapabilities(),
				implementation: client.getServerVersion(),
				instructions: client.getInstructions(),
				error: undefined,
			};
			statuses.set(serverName, status);
			const identifier =
				serverConfig.type === 'stdio' ? serverConfig.command : serverConfig.url;
			trafficStore?.upsertBackendInfo({
				backend: serverName,
				url: identifier,
				capabilities: status.capabilities,
				implementation: status.implementation,
				instructions: status.instructions,
			});
			logger.info(`Connected to MCP upstream "${serverName}"`);
			return true;
		} catch (err) {
			if (!isCurrentConnectionAttempt(server, connectionEpoch)) {
				client.onerror = () => undefined;
				await client.close().catch(() => undefined);
				await transport.close().catch(() => undefined);
				return false;
			}
			const message = errorMessage(err);
			logger.error(
				`Failed to connect to MCP upstream "${serverName}": ${message}`,
			);
			setMcpUpstreamStatus({
				server,
				connected: false,
				error: message,
				errorState: 'runtime',
				actionRequired: false,
			});
			await transport.close().catch(() => undefined);
			return false;
		}
	};

	const attemptReconnect = async (server: McpUpstreamServer): Promise<void> => {
		if (!server.serverConfig.enabled) return;
		if (configErrorBackends.has(server.serverName)) return;

		logger.info(
			`Attempting to reconnect to MCP upstream "${server.serverName}"...`,
		);
		const success = await connectToMcpUpstream(server);
		if (success) {
			await refreshCatalog(server);
			if (configErrorBackends.has(server.serverName)) return;
			if (!server.serverConfig.enabled || !clients.has(server.serverName))
				return;
			healthCheckReadyBackends.add(server.serverName);
			logger.info(`MCP upstream "${server.serverName}" recovered successfully`);
			return;
		}

		scheduleReconnect(server);
	};

	const healthChecks = createMcpUpstreamHealthChecks({
		clients,
		getServer,
		healthCheckFailures,
		healthCheckReadyBackends,
		markMcpUpstreamDown,
		onValidationError,
		waitForRateLimit,
	});

	const clearReconnectTimer = (serverName: string): void => {
		const timer = reconnectTimers.get(serverName);
		if (!timer) return;
		clearTimeout(timer);
		reconnectTimers.delete(serverName);
	};

	const setBackendEnabled = async (
		server: McpUpstreamServer,
		enabled: boolean,
	): Promise<void> => {
		const serverName = server.serverName;
		advanceConnectionEpoch(serverName);
		server.serverConfig.enabled = enabled;

		if (!enabled) {
			healthCheckReadyBackends.delete(serverName);
			clearReconnectTimer(serverName);
			configErrorBackends.delete(serverName);
			healthCheckFailures.delete(serverName);
			requestQueues.delete(serverName);
			toolsCache.delete(serverName);
			promptsCache.delete(serverName);
			resourcesCache.delete(serverName);
			await closeMcpUpstreamConnection(server, true);
			suppressClientErrorsUntil.delete(serverName);
			setMcpUpstreamStatus({
				server,
				connected: false,
				actionRequired: false,
				preserveDetails: false,
			});
			logger.info(`Disabled MCP upstream "${serverName}"`);
			return;
		}

		configErrorBackends.delete(serverName);
		setMcpUpstreamStatus({
			server,
			connected: false,
			actionRequired: false,
		});
		const connected = await connectToMcpUpstream(server);
		if (!connected) {
			scheduleReconnect(server);
			return;
		}
		await refreshCatalog(server);
		if (configErrorBackends.has(serverName)) return;
		if (!server.serverConfig.enabled || !clients.has(serverName)) return;
		healthCheckReadyBackends.add(serverName);
		logger.info(`Enabled MCP upstream "${serverName}"`);
	};

	const initialize = async (): Promise<void> => {
		const configuredServers = Array.from(servers.values()).filter((server) => {
			if (server.serverConfig.enabled) return true;
			setMcpUpstreamStatus({
				server,
				connected: false,
				actionRequired: false,
			});
			return false;
		});
		const connectionResults = await Promise.allSettled(
			configuredServers.map((server) => connectToMcpUpstream(server)),
		);

		connectionResults.forEach((result, index) => {
			const server = configuredServers[index];
			if (!server) return;
			if (result.status === 'rejected') {
				logger.warn(
					`MCP upstream "${server.serverName}" connection failed: ${result.reason}`,
				);
				return;
			}
			if (result.status === 'fulfilled' && !result.value) {
				scheduleReconnect(server);
			}
		});

		await Promise.allSettled(
			Array.from(clients.keys()).map(async (serverName) => {
				const server = getServer(serverName);
				if (!server) return;
				await refreshCatalog(server);
				if (configErrorBackends.has(serverName)) return;
				if (!server.serverConfig.enabled || !clients.has(serverName)) return;
				healthCheckReadyBackends.add(serverName);
			}),
		);
		healthChecks.startHealthChecks();
	};

	const getClient = (getClientParams: GetClientParams) =>
		clients.get(getClientParams.serverName);

	const getAllClients = (): McpUpstreamClientsMap => new Map(clients);

	const disconnect = async (): Promise<void> => {
		healthChecks.stopHealthChecks();
		healthCheckReadyBackends.clear();
		healthCheckFailures.clear();
		for (const serverName of servers.keys()) {
			advanceConnectionEpoch(serverName);
		}

		for (const [, timer] of reconnectTimers) {
			clearTimeout(timer);
		}
		reconnectTimers.clear();

		for (const [serverName, queue] of requestQueues) {
			for (const { reject } of queue.pending) {
				reject(new Error(`MCP upstream "${serverName}" is disconnecting`));
			}
		}
		requestQueues.clear();

		for (const [serverName, client] of clients) {
			try {
				await client.close();
			} catch (err) {
				logger.warn(
					`Error closing MCP upstream client "${serverName}": ${errorMessage(err)}`,
				);
			}
		}

		for (const [serverName, transport] of transports) {
			try {
				await transport.close();
			} catch (err) {
				logger.error(
					`Error closing MCP upstream transport for "${serverName}": ${errorMessage(err)}`,
				);
			}
		}

		clients.clear();
		transports.clear();
		toolsCache.clear();
		promptsCache.clear();
		resourcesCache.clear();
		for (const server of servers.values()) {
			setMcpUpstreamStatus({
				server,
				connected: false,
				error: 'Disconnected',
				errorState: 'runtime',
				actionRequired: false,
			});
		}
	};

	const getStatuses = (): McpUpstreamStatus[] =>
		Array.from(statuses.values()).map((status) => {
			const server = servers.get(status.serverName);
			if (!server) return status;
			return {
				...status,
				enabled: server.serverConfig.enabled,
				enabledTools: server.serverConfig.enabledTools ?? [],
			};
		});

	return {
		attemptReconnect,
		disconnect,
		getAllClients,
		getClient,
		getServer,
		getStatuses,
		initialize,
		markMcpUpstreamConfigurationError,
		onValidationError,
		setMcpUpstreamStatusError,
		setBackendEnabled,
		waitForRateLimit,
	};
};

export { createMcpUpstreamConnections };
