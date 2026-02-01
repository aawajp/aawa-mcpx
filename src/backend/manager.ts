import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
	CallToolResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type {
	BackendManager,
	BackendStatus,
	CallToolParams,
	ClientsMap,
	CreateBackendManagerParams,
	GetClientParams,
	GetPromptParams,
	PromptsMap,
	ReadResourceParams,
	RequestQueue,
	ResourcesMap,
	ToolsMap,
} from '@/backend/types';
import type { McpServerConfig } from '@/config/types';
import { logger } from '@/utils/logger';

const HEALTH_CHECK_INTERVAL_MS = 5000;
const RECONNECT_INTERVAL_MS = 5000;
const DEFAULT_TRAFFIC_LIMIT = 1;
const MIN_INTERVAL_MS = 1000;

const createBackendManager = (
	params: CreateBackendManagerParams,
): BackendManager => {
	const { config, trafficStore } = params;

	const serverConfigs = new Map<string, McpServerConfig>(
		Object.entries(config.mcpServers),
	);
	const clients: ClientsMap = new Map();
	const transports = new Map<string, StreamableHTTPClientTransport>();
	const toolsCache: ToolsMap = new Map();
	const promptsCache: PromptsMap = new Map();
	const resourcesCache: ResourcesMap = new Map();
	const statuses = new Map<string, BackendStatus>();
	const reconnectTimers = new Map<string, Timer>();
	const requestQueues = new Map<string, RequestQueue>();
	let healthCheckTimer: Timer | null = null;

	const getTimeout = (serverName: string): number => {
		const serverConfig = serverConfigs.get(serverName);
		return serverConfig?.timeout ?? 30000;
	};

	const getTrafficLimit = (serverName: string): number => {
		const serverConfig = serverConfigs.get(serverName);
		return serverConfig?.trafficLimit ?? DEFAULT_TRAFFIC_LIMIT;
	};

	const getOrCreateQueue = (serverName: string): RequestQueue => {
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

	const waitForRateLimit = async (serverName: string): Promise<void> => {
		const queue = getOrCreateQueue(serverName);
		const now = Date.now();
		const trafficLimit = getTrafficLimit(serverName);
		const minInterval = MIN_INTERVAL_MS / trafficLimit;
		const timeSinceLastRequest = now - queue.lastRequestTime;

		if (timeSinceLastRequest < minInterval) {
			const waitTime = minInterval - timeSinceLastRequest;
			await Bun.sleep(waitTime);
		}

		queue.lastRequestTime = Date.now();
	};

	// Mark backend as down: remove from clients, update status, schedule reconnect
	const markBackendDown = (serverName: string, error: string): void => {
		const existingClient = clients.get(serverName);
		const existingTransport = transports.get(serverName);
		if (existingClient) {
			existingClient.close().catch((err) => {
				logger.error(
					`Error closing client for "${serverName}": ${(err as Error).message}`,
				);
			});
			clients.delete(serverName);
		}
		if (existingTransport) {
			existingTransport.close().catch((err) => {
				logger.error(
					`Error closing transport for "${serverName}": ${(err as Error).message}`,
				);
			});
			transports.delete(serverName);
		}
		const serverConfig = serverConfigs.get(serverName);
		statuses.set(serverName, {
			serverName,
			url: serverConfig?.url ?? '',
			connected: false,
			error,
		});
		logger.warn(`Backend "${serverName}" marked as down: ${error}`);
		scheduleReconnect(serverName);
	};

	// Schedule reconnection attempt with fixed interval
	const scheduleReconnect = (serverName: string): void => {
		if (reconnectTimers.has(serverName)) return;
		const timer = setTimeout(() => {
			reconnectTimers.delete(serverName);
			const serverConfig = serverConfigs.get(serverName);
			if (!serverConfig) return;
			attemptReconnect(serverName, serverConfig);
		}, RECONNECT_INTERVAL_MS);
		reconnectTimers.set(serverName, timer);
	};

	// Attempt to reconnect to a backend
	const attemptReconnect = async (
		serverName: string,
		serverConfig: McpServerConfig,
	): Promise<void> => {
		logger.info(`Attempting to reconnect to backend "${serverName}"...`);
		const success = await connectToBackend(serverName, serverConfig);
		if (success) {
			// Fetch tools/prompts/resources on recovery
			await Promise.allSettled([
				fetchTools(serverName),
				fetchPrompts(serverName),
				fetchResources(serverName),
			]);
			logger.info(`Backend "${serverName}" recovered successfully`);
		} else {
			// Schedule next reconnect attempt
			scheduleReconnect(serverName);
		}
	};

	// Health check for a single backend - uses ping if available, otherwise listTools
	const checkBackendHealth = async (serverName: string): Promise<boolean> => {
		const client = clients.get(serverName);
		if (!client) return false;

		try {
			// Enforce rate limit for health checks
			await waitForRateLimit(serverName);
			// Try to ping the backend (lightweight check)
			await client.ping({ timeout: 5000 });
			return true;
		} catch (error) {
			logger.warn(
				`Health check failed for "${serverName}": ${(error as Error).message}`,
			);
			return false;
		}
	};

	// Run health checks on all connected backends
	const runHealthChecks = async (): Promise<void> => {
		const connectedServers = Array.from(clients.keys());
		await Promise.allSettled(
			connectedServers.map(async (serverName) => {
				const healthy = await checkBackendHealth(serverName);
				if (!healthy) {
					markBackendDown(serverName, 'Health check failed');
				}
			}),
		);
	};

	// Start periodic health checks
	const startHealthChecks = (): void => {
		if (healthCheckTimer) return;
		healthCheckTimer = setInterval(() => {
			runHealthChecks();
		}, HEALTH_CHECK_INTERVAL_MS);
	};

	// Stop health checks
	const stopHealthChecks = (): void => {
		if (healthCheckTimer) {
			clearInterval(healthCheckTimer);
			healthCheckTimer = null;
		}
	};

	// Returns true if connection succeeded, false otherwise
	const connectToBackend = async (
		serverName: string,
		serverConfig: McpServerConfig,
	): Promise<boolean> => {
		const existingClient = clients.get(serverName);
		const existingTransport = transports.get(serverName);
		if (existingClient) {
			await existingClient.close().catch(() => undefined);
			clients.delete(serverName);
		}
		if (existingTransport) {
			await existingTransport.close().catch(() => undefined);
			transports.delete(serverName);
		}

		const transport = new StreamableHTTPClientTransport(
			new URL(serverConfig.url),
			{
				requestInit: serverConfig.headers
					? { headers: serverConfig.headers as HeadersInit }
					: undefined,
			},
		);
		const client = new Client({
			name: `aawa-mcpx-${serverName}`,
			version: '1.0.0',
		});

		client.onerror = (error: unknown) => {
			logger.error(
				`Client error for "${serverName}": ${(error as Error).message}`,
			);
			markBackendDown(serverName, (error as Error).message);
		};

		try {
			await client.connect(transport, { timeout: serverConfig.timeout });
			clients.set(serverName, client);
			transports.set(serverName, transport);
			const status: BackendStatus = {
				serverName,
				url: serverConfig.url,
				connected: true,
				capabilities: client.getServerCapabilities(),
				implementation: client.getServerVersion(),
				instructions: client.getInstructions(),
				error: undefined,
			};
			statuses.set(serverName, status);
			trafficStore?.upsertBackendInfo({
				backend: serverName,
				url: serverConfig.url,
				capabilities: status.capabilities,
				implementation: status.implementation,
				instructions: status.instructions,
			});
			logger.info(`Connected to backend "${serverName}"`);
			return true;
		} catch (error) {
			logger.error(
				`Failed to connect to backend "${serverName}": ${(error as Error).message}`,
			);
			statuses.set(serverName, {
				serverName,
				url: serverConfig.url,
				connected: false,
				error: (error as Error).message,
			});
			await transport.close().catch(() => undefined);
			return false;
		}
	};

	const initialize = async (): Promise<void> => {
		const entries = Array.from(serverConfigs.entries());

		// Connect to all backends in parallel - failures are isolated via allSettled
		const connectionResults = await Promise.allSettled(
			entries.map(([serverName, serverConfig]) =>
				connectToBackend(serverName, serverConfig),
			),
		);

		// Log any connection failures with the backend name
		connectionResults.forEach((result, index) => {
			if (result.status === 'rejected') {
				const entry = entries[index];
				if (entry) {
					const [serverName] = entry;
					logger.warn(
						`Backend "${serverName}" connection failed: ${result.reason}`,
					);
				}
			} else if (result.status === 'fulfilled' && !result.value) {
				// connectToBackend returned false
				const entry = entries[index];
				if (entry) {
					const [serverName] = entry;
					scheduleReconnect(serverName);
				}
			}
		});

		// Fetch and cache tools/prompts/resources once during boot
		// Each backend is fetched independently - failures are isolated
		await Promise.allSettled(
			Array.from(clients.keys()).map(async (serverName) => {
				// Fetch all three in parallel for this backend
				await Promise.allSettled([
					fetchTools(serverName),
					fetchPrompts(serverName),
					fetchResources(serverName),
				]);
			}),
		);

		// Start health checks after initial boot
		startHealthChecks();
	};

	const getClient = (params: GetClientParams) => clients.get(params.serverName);

	const getAllClients = (): ClientsMap => new Map(clients);

	const disconnect = async (): Promise<void> => {
		// Stop health checks
		stopHealthChecks();

		// Clear reconnect timers
		for (const [, timer] of reconnectTimers) {
			clearTimeout(timer);
		}
		reconnectTimers.clear();

		// Clear request queues
		for (const [serverName, queue] of requestQueues) {
			// Reject all pending requests
			for (const { reject } of queue.pending) {
				reject(new Error(`Backend "${serverName}" is disconnecting`));
			}
		}
		requestQueues.clear();

		// Close all clients
		for (const [serverName, client] of clients) {
			try {
				await client.close();
			} catch (error) {
				logger.warn(
					`Error closing client "${serverName}": ${(error as Error).message}`,
				);
			}
		}

		// Close all transports
		for (const [serverName, transport] of transports) {
			try {
				await transport.close();
			} catch (error) {
				logger.error(
					`Error closing transport for "${serverName}": ${(error as Error).message}`,
				);
			}
		}

		clients.clear();
		transports.clear();
		toolsCache.clear();
		promptsCache.clear();
		resourcesCache.clear();
		for (const [serverName, serverConfig] of serverConfigs) {
			statuses.set(serverName, {
				serverName,
				url: serverConfig.url,
				connected: false,
				error: 'Disconnected',
			});
		}
	};

	const emptyToolsResult = (): ListToolsResult => ({ tools: [] });
	const emptyPromptsResult = (): ListPromptsResult => ({ prompts: [] });
	const emptyResourcesResult = (): ListResourcesResult => ({ resources: [] });

	// Check if error is a "method not found" error (capability not supported by backend)
	const isMethodNotFoundError = (error: unknown): boolean => {
		const err = error as { code?: number };
		return err?.code === -32601;
	};

	const fetchTools = async (serverName: string): Promise<ListToolsResult> => {
		const client = clients.get(serverName);
		if (!client) {
			return emptyToolsResult();
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.listTools(
				{},
				{ timeout: getTimeout(serverName) },
			);
			toolsCache.set(serverName, result);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: 'tools/list',
				request: {},
				response: result,
			});
			trafficStore?.upsertTools({ backend: serverName, tools: result.tools });
			return result;
		} catch (error) {
			if (isMethodNotFoundError(error)) {
				logger.info(`Backend "${serverName}" does not support tools/list`);
				toolsCache.set(serverName, emptyToolsResult());
				return emptyToolsResult();
			}
			logger.error(
				`Failed to list tools for "${serverName}": ${(error as Error).message}`,
			);
			statuses.set(serverName, {
				...(statuses.get(serverName) ?? {
					serverName,
					url: serverConfigs.get(serverName)?.url ?? '',
					connected: true,
				}),
				error: (error as Error).message,
			});
			return emptyToolsResult();
		}
	};

	const fetchPrompts = async (
		serverName: string,
	): Promise<ListPromptsResult> => {
		const client = clients.get(serverName);
		if (!client) {
			return emptyPromptsResult();
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.listPrompts(
				{},
				{ timeout: getTimeout(serverName) },
			);
			promptsCache.set(serverName, result);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: 'prompts/list',
				request: {},
				response: result,
			});
			trafficStore?.upsertPrompts({
				backend: serverName,
				prompts: result.prompts,
			});
			return result;
		} catch (error) {
			if (isMethodNotFoundError(error)) {
				logger.info(`Backend "${serverName}" does not support prompts/list`);
				promptsCache.set(serverName, emptyPromptsResult());
				return emptyPromptsResult();
			}
			logger.error(
				`Failed to list prompts for "${serverName}": ${(error as Error).message}`,
			);
			promptsCache.set(serverName, emptyPromptsResult());
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: 'prompts/list',
				request: {},
				response: { error: (error as Error).message },
			});
			statuses.set(serverName, {
				...(statuses.get(serverName) ?? {
					serverName,
					url: serverConfigs.get(serverName)?.url ?? '',
					connected: true,
				}),
				error: (error as Error).message,
			});
			return emptyPromptsResult();
		}
	};

	const fetchResources = async (
		serverName: string,
	): Promise<ListResourcesResult> => {
		const client = clients.get(serverName);
		if (!client) {
			return emptyResourcesResult();
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.listResources(
				{},
				{ timeout: getTimeout(serverName) },
			);
			resourcesCache.set(serverName, result);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: 'resources/list',
				request: {},
				response: result,
			});
			trafficStore?.upsertResources({
				backend: serverName,
				resources: result.resources,
			});
			return result;
		} catch (error) {
			if (isMethodNotFoundError(error)) {
				logger.info(`Backend "${serverName}" does not support resources/list`);
				resourcesCache.set(serverName, emptyResourcesResult());
				return emptyResourcesResult();
			}
			logger.error(
				`Failed to list resources for "${serverName}": ${(error as Error).message}`,
			);
			resourcesCache.set(serverName, emptyResourcesResult());
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: 'resources/list',
				request: {},
				response: { error: (error as Error).message },
			});
			statuses.set(serverName, {
				...(statuses.get(serverName) ?? {
					serverName,
					url: serverConfigs.get(serverName)?.url ?? '',
					connected: true,
				}),
				error: (error as Error).message,
			});
			return emptyResourcesResult();
		}
	};

	// Return cached tools - no network calls
	const listAllTools = (): ToolsMap => {
		return new Map(toolsCache);
	};

	// Return cached prompts - no network calls
	const listAllPrompts = (): PromptsMap => {
		return new Map(promptsCache);
	};

	// Return cached resources - no network calls
	const listAllResources = (): ResourcesMap => {
		return new Map(resourcesCache);
	};

	const callTool = async (params: CallToolParams): Promise<CallToolResult> => {
		const { serverName, toolName, args } = params;
		const client = clients.get(serverName);
		if (!client) {
			return {
				content: [
					{ type: 'text', text: `Backend "${serverName}" is not available` },
				],
				isError: true,
			};
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.callTool(
				{ name: toolName, arguments: args },
				CallToolResultSchema,
				{ timeout: getTimeout(serverName) },
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `tools/call:${toolName}`,
				request: args,
				response: result,
			});
			// NOTE: The SDK's client.callTool() returns CompatibilityCallToolResult
			// which is a union of modern (content field) and legacy (toolResult field) formats.
			// We assume modern backends returning the content field.
			// Legacy toolResult format from older MCP backends is NOT supported.
			// If legacy support is needed in the future, normalize the result here.
			return result as CallToolResult;
		} catch (error) {
			logger.error(
				`Failed to call tool "${toolName}" on "${serverName}": ${(error as Error).message}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `tools/call:${toolName}`,
				request: args,
				response: { error: (error as Error).message },
			});
			return {
				content: [
					{
						type: 'text',
						text: `Server "${serverName}" error: ${(error as Error).message}`,
					},
				],
				isError: true,
			};
		}
	};

	const getPrompt = async (params: GetPromptParams) => {
		const { serverName, promptName, args } = params;
		const client = clients.get(serverName);
		if (!client) {
			throw new Error(`Backend "${serverName}" is not available`);
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.getPrompt(
				{ name: promptName, arguments: args },
				{ timeout: getTimeout(serverName) },
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `prompts/get:${promptName}`,
				request: args,
				response: result,
			});
			return result;
		} catch (error) {
			logger.error(
				`Failed to get prompt "${promptName}" from "${serverName}": ${(error as Error).message}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `prompts/get:${promptName}`,
				request: args,
				response: { error: (error as Error).message },
			});
			throw new Error(
				`Server "${serverName}" error: ${(error as Error).message}`,
			);
		}
	};

	const readResource = async (params: ReadResourceParams) => {
		const { serverName, uri } = params;
		const client = clients.get(serverName);
		if (!client) {
			throw new Error(`Backend "${serverName}" is not available`);
		}

		// Enforce rate limit
		await waitForRateLimit(serverName);

		try {
			const result = await client.readResource(
				{ uri },
				{ timeout: getTimeout(serverName) },
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `resources/read:${uri}`,
				request: { uri },
				response: result,
			});
			return result;
		} catch (error) {
			logger.error(
				`Failed to read resource "${uri}" from "${serverName}": ${(error as Error).message}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `resources/read:${uri}`,
				request: { uri },
				response: { error: (error as Error).message },
			});
			throw new Error(
				`Server "${serverName}" error: ${(error as Error).message}`,
			);
		}
	};

	const getStatuses = (): BackendStatus[] => Array.from(statuses.values());

	return {
		initialize,
		getClient,
		getAllClients,
		disconnect,
		listAllTools,
		listAllPrompts,
		listAllResources,
		callTool,
		getPrompt,
		readResource,
		getStatuses,
	};
};

export { createBackendManager };
