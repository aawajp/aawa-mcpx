import type {
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	Tool,
} from '@modelcontextprotocol/sdk/types';
import { type } from 'arktype';

import { saveToolState } from '@/config/loader';
import type { McpConfig } from '@/config/schema';
import type {
	Client,
	McpUpstreamClientsMap,
	McpUpstreamPromptsMap,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamToolsMap,
	OnValidationError,
	ToggleToolParams,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import {
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
} from '@/shared/mcp_schemas';

type CreateMcpUpstreamCatalogParams = {
	attemptReconnect: (server: McpUpstreamServer) => Promise<void>;
	clients: McpUpstreamClientsMap;
	config: McpConfig;
	configErrorBackends: Set<string>;
	getServer: (serverName: string) => McpUpstreamServer | undefined;
	markMcpUpstreamConfigurationError: (
		server: McpUpstreamServer,
		error: string,
	) => void;
	onValidationError: OnValidationError;
	promptsCache: McpUpstreamPromptsMap;
	resourcesCache: McpUpstreamResourcesMap;
	setMcpUpstreamStatusError: (server: McpUpstreamServer, error: string) => void;
	toolsCache: McpUpstreamToolsMap;
	trafficStore?: TrafficStore;
	waitForRateLimit: (server: McpUpstreamServer) => Promise<void>;
};

const emptyToolsResult = (): ListToolsResult => ({
	tools: [],
});

const emptyPromptsResult = (): ListPromptsResult => ({
	prompts: [],
});

const emptyResourcesResult = (): ListResourcesResult => ({
	resources: [],
});

const getToolNames = (tools: Tool[]): string[] => {
	return Array.from(new Set(tools.map((tool) => tool.name)));
};

const normalizeEnabledTools = (params: {
	toolNames: string[];
	enabledTools?: string[];
}): string[] => {
	const source = params.enabledTools ?? params.toolNames;
	const toolSet = new Set(params.toolNames);
	const seen = new Set<string>();
	const normalized: string[] = [];

	source.forEach((toolName) => {
		if (!toolSet.has(toolName)) return;
		if (seen.has(toolName)) return;
		seen.add(toolName);
		normalized.push(toolName);
	});

	return normalized;
};

const getInvalidEnabledTools = (params: {
	toolNames: string[];
	enabledTools?: string[];
}): string[] => {
	if (!params.enabledTools) {
		return [];
	}
	const toolSet = new Set(params.toolNames);
	const seen = new Set<string>();
	const invalid: string[] = [];
	params.enabledTools.forEach((toolName) => {
		if (seen.has(toolName)) return;
		seen.add(toolName);
		if (!toolSet.has(toolName)) {
			invalid.push(toolName);
		}
	});
	return invalid;
};

const persistToolState = async (params: {
	config: McpConfig;
	server: McpUpstreamServer;
	enabledTools: string[];
	availableTools: string[];
}): Promise<void> => {
	await saveToolState({
		config: params.config,
		serverName: params.server.serverName,
		enabledTools: params.enabledTools,
		availableTools: params.availableTools,
	});
};

const isMethodNotFoundError = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) return false;
	return 'code' in error && error.code === -32601;
};

const createMcpUpstreamCatalog = (params: CreateMcpUpstreamCatalogParams) => {
	const {
		attemptReconnect,
		clients,
		config,
		configErrorBackends,
		getServer,
		markMcpUpstreamConfigurationError,
		onValidationError,
		promptsCache,
		resourcesCache,
		setMcpUpstreamStatusError,
		toolsCache,
		trafficStore,
		waitForRateLimit,
	} = params;

	const isCurrentCatalogClient = (catalogParams: {
		server: McpUpstreamServer;
		client: Client;
	}): boolean => {
		return (
			catalogParams.server.serverConfig.enabled &&
			clients.get(catalogParams.server.serverName) === catalogParams.client
		);
	};

	const getEnabledToolSet = (catalogParams: {
		server: McpUpstreamServer;
		tools: Tool[];
	}): Set<string> => {
		const enabledTools = normalizeEnabledTools({
			toolNames: getToolNames(catalogParams.tools),
			enabledTools: catalogParams.server.serverConfig.enabledTools,
		});
		return new Set(enabledTools);
	};

	const initializeToolState = async (catalogParams: {
		server: McpUpstreamServer;
		tools: Tool[];
	}): Promise<void> => {
		const toolNames = getToolNames(catalogParams.tools);
		let enabledTools = catalogParams.server.serverConfig.enabledTools;
		if (!enabledTools) {
			enabledTools = normalizeEnabledTools({
				toolNames,
			});
			catalogParams.server.serverConfig.enabledTools = enabledTools;
		}
		catalogParams.server.serverConfig.availableTools = toolNames;
		try {
			await persistToolState({
				config,
				server: catalogParams.server,
				enabledTools,
				availableTools: toolNames,
			});
		} catch (err) {
			logger.error(
				`Failed to persist tool state for "${catalogParams.server.serverName}": ${errorMessage(err)}`,
			);
		}
	};

	const fetchTools = async (
		server: McpUpstreamServer,
	): Promise<ListToolsResult> => {
		const serverName = server.serverName;
		const client = clients.get(serverName);
		if (!client) {
			return emptyToolsResult();
		}

		try {
			await waitForRateLimit(server);
			if (
				!isCurrentCatalogClient({
					server,
					client,
				})
			)
				return emptyToolsResult();
			const result = await client.listTools(
				{},
				{
					timeout: server.serverConfig.timeout,
				},
			);
			if (
				!isCurrentCatalogClient({
					server,
					client,
				})
			)
				return emptyToolsResult();
			const parsed = listToolsResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server,
					method: 'tools/list',
					error: parsed,
				});
			}
			toolsCache.set(serverName, result);
			await initializeToolState({
				server,
				tools: result.tools,
			});
			if (
				!isCurrentCatalogClient({
					server,
					client,
				})
			)
				return emptyToolsResult();
			const invalidEnabledTools = getInvalidEnabledTools({
				toolNames: getToolNames(result.tools),
				enabledTools: server.serverConfig.enabledTools,
			});
			if (invalidEnabledTools.length > 0) {
				const error = `Configuration error: enabledTools has unknown tools: ${invalidEnabledTools.join(', ')}`;
				trafficStore?.logBackendTraffic({
					protocolVersion: client.protocolVersion,
					backend: serverName,
					method: 'tools/list:configuration_error',
					request: {
						enabledTools: server.serverConfig.enabledTools ?? [],
						availableTools: getToolNames(result.tools),
					},
					response: {
						error: {
							type: 'configuration_error',
							message: error,
							invalidEnabledTools,
						},
					},
				});
				markMcpUpstreamConfigurationError(server, error);
				return result;
			}
			configErrorBackends.delete(serverName);
			trafficStore?.logBackendTraffic({
				protocolVersion: client.protocolVersion,
				backend: serverName,
				method: 'tools/list',
				request: {},
				response: result,
			});
			trafficStore?.upsertTools({
				backend: serverName,
				tools: result.tools,
			});
			return result;
		} catch (err) {
			if (
				!isCurrentCatalogClient({
					server,
					client,
				})
			)
				return emptyToolsResult();
			if (isMethodNotFoundError(err)) {
				logger.info(`MCP upstream "${serverName}" does not support tools/list`);
				toolsCache.set(serverName, emptyToolsResult());
				return emptyToolsResult();
			}
			logger.error(
				`Failed to list tools for MCP upstream "${serverName}": ${errorMessage(err)}`,
			);
			setMcpUpstreamStatusError(server, errorMessage(err));
			return emptyToolsResult();
		}
	};

	// Prompts and resources share cache/error policy. Tools also persist exposure
	// configuration and retain their cache on runtime errors, so use their own flow.
	const fetchCatalog = async <T>(
		server: McpUpstreamServer,
		options: {
			method: string;
			empty: () => T;
			cache: Map<string, T>;
			fetch: (client: Client) => Promise<T>;
			validate: (result: T) => unknown;
			persist: (result: T) => void;
		},
	): Promise<T> => {
		const serverName = server.serverName;
		const client = clients.get(serverName);
		if (!client) return options.empty();
		const isCurrent = (): boolean =>
			isCurrentCatalogClient({
				server,
				client,
			});
		try {
			await waitForRateLimit(server);
			if (!isCurrent()) return options.empty();
			const result = await options.fetch(client);
			// A backend may be disabled or reconnected while the request is in flight.
			if (!isCurrent()) return options.empty();
			const parsed = options.validate(result);
			if (parsed instanceof type.errors)
				onValidationError({
					server,
					method: options.method,
					error: parsed,
				});
			options.cache.set(serverName, result);
			trafficStore?.logBackendTraffic({
				protocolVersion: client.protocolVersion,
				backend: serverName,
				method: options.method,
				request: {},
				response: result,
			});
			options.persist(result);
			return result;
		} catch (error) {
			if (!isCurrent()) return options.empty();
			const empty = options.empty();
			options.cache.set(serverName, empty);
			if (isMethodNotFoundError(error)) {
				logger.info(
					`MCP upstream "${serverName}" does not support ${options.method}`,
				);
				return empty;
			}
			logger.error(
				`Failed to fetch ${options.method} for MCP upstream "${serverName}": ${errorMessage(error)}`,
			);
			trafficStore?.logBackendTraffic({
				protocolVersion: client.protocolVersion,
				backend: serverName,
				method: options.method,
				request: {},
				response: {
					error: errorMessage(error),
				},
			});
			setMcpUpstreamStatusError(server, errorMessage(error));
			return empty;
		}
	};
	const fetchPrompts = (
		server: McpUpstreamServer,
	): Promise<ListPromptsResult> =>
		fetchCatalog(server, {
			method: 'prompts/list',
			empty: emptyPromptsResult,
			cache: promptsCache,
			fetch: (client) =>
				client.listPrompts(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
			validate: listPromptsResultType,
			persist: (result) =>
				trafficStore?.upsertPrompts({
					backend: server.serverName,
					prompts: result.prompts,
				}),
		});
	const fetchResources = (
		server: McpUpstreamServer,
	): Promise<ListResourcesResult> =>
		fetchCatalog(server, {
			method: 'resources/list',
			empty: emptyResourcesResult,
			cache: resourcesCache,
			fetch: (client) =>
				client.listResources(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
			validate: listResourcesResultType,
			persist: (result) =>
				trafficStore?.upsertResources({
					backend: server.serverName,
					resources: result.resources,
				}),
		});

	const listAllTools = (): McpUpstreamToolsMap => {
		return new Map(toolsCache);
	};

	const listEnabledTools = (): McpUpstreamToolsMap => {
		const result: McpUpstreamToolsMap = new Map();
		for (const [serverName, toolsResult] of toolsCache) {
			if (configErrorBackends.has(serverName)) {
				result.set(serverName, {
					...toolsResult,
					tools: [],
				});
				continue;
			}
			const server = getServer(serverName);
			if (!server) {
				result.set(serverName, toolsResult);
				continue;
			}
			const enabledSet = getEnabledToolSet({
				server,
				tools: toolsResult.tools,
			});
			const filteredTools = toolsResult.tools.filter((tool) =>
				enabledSet.has(tool.name),
			);
			result.set(serverName, {
				...toolsResult,
				tools: filteredTools,
			});
		}
		return result;
	};

	const listAllPrompts = (): McpUpstreamPromptsMap => {
		return new Map(promptsCache);
	};

	const listAllResources = (): McpUpstreamResourcesMap => {
		return new Map(resourcesCache);
	};

	const getEnabledTools = (catalogParams: { serverName: string }): string[] => {
		const server = getServer(catalogParams.serverName);
		const tools = toolsCache.get(catalogParams.serverName)?.tools ?? [];
		if (!server) {
			return [];
		}
		return normalizeEnabledTools({
			toolNames: getToolNames(tools),
			enabledTools: server.serverConfig.enabledTools,
		});
	};

	const toggleTool = async (
		catalogParams: ToggleToolParams,
	): Promise<string[]> => {
		const server = getServer(catalogParams.serverName);
		if (!server) {
			throw new Error(
				`MCP upstream "${catalogParams.serverName}" is not available`,
			);
		}
		const tools = toolsCache.get(catalogParams.serverName)?.tools ?? [];
		const toolNames = getToolNames(tools);
		if (!toolNames.includes(catalogParams.toolName)) {
			throw new Error(
				`Tool "${catalogParams.toolName}" is not available on MCP upstream "${catalogParams.serverName}"`,
			);
		}

		const currentEnabled = normalizeEnabledTools({
			toolNames,
			enabledTools: server.serverConfig.enabledTools,
		});
		const currentSet = new Set(currentEnabled);
		if (catalogParams.enabled) {
			currentSet.add(catalogParams.toolName);
		}
		if (!catalogParams.enabled) {
			currentSet.delete(catalogParams.toolName);
		}

		const nextEnabled = toolNames.filter((toolName) =>
			currentSet.has(toolName),
		);
		const previousEnabled = server.serverConfig.enabledTools;
		const previousAvailable = server.serverConfig.availableTools;
		server.serverConfig.enabledTools = nextEnabled;
		server.serverConfig.availableTools = toolNames;

		try {
			await persistToolState({
				config,
				server,
				enabledTools: nextEnabled,
				availableTools: toolNames,
			});
			const invalidEnabledTools = getInvalidEnabledTools({
				toolNames,
				enabledTools: nextEnabled,
			});
			if (invalidEnabledTools.length === 0) {
				const hadConfigError = configErrorBackends.delete(server.serverName);
				if (hadConfigError) {
					await attemptReconnect(server);
				}
			}
			return nextEnabled;
		} catch (err) {
			server.serverConfig.enabledTools = previousEnabled;
			server.serverConfig.availableTools = previousAvailable;
			throw err;
		}
	};

	return {
		fetchPrompts,
		fetchResources,
		fetchTools,
		getEnabledTools,
		listAllPrompts,
		listAllResources,
		listAllTools,
		listEnabledTools,
		toggleTool,
	};
};

export { createMcpUpstreamCatalog };
