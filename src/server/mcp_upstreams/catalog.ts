import type {
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import { saveToolState } from '@/server/config/loader';
import type { McpConfig } from '@/server/config/schema';
import { logger } from '@/server/logger';
import { createInputSchemaCompiler } from '@/server/mcp_upstreams/input_schema';
import type { CompiledSchema } from '@/server/mcp_upstreams/json_schema';
import type {
	Client,
	EnabledTool,
	McpUpstreamBackend,
	McpUpstreamPromptsMap,
	McpUpstreamResourcesMap,
	McpUpstreamResourceTemplatesMap,
	McpUpstreamToolsMap,
	ToggleToolParams,
} from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { toolHeaderParameters } from '@/shared/mcp_protocol';

type CreateMcpUpstreamCatalogParams = {
	attemptReconnect: (backend: McpUpstreamBackend) => Promise<void>;
	backends: Map<string, McpUpstreamBackend>;
	config: McpConfig;
	configPath: string;
	markMcpUpstreamConfigurationError: (
		backend: McpUpstreamBackend,
		error: string,
	) => void;
	setMcpUpstreamStatusError: (
		backend: McpUpstreamBackend,
		error: string,
	) => void;
	trafficStore?: TrafficStore;
	waitForRateLimit: (backend: McpUpstreamBackend) => Promise<void>;
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

const emptyResourceTemplatesResult = (): ListResourceTemplatesResult => ({
	resourceTemplates: [],
});

const getToolNames = (tools: Tool[]): string[] => {
	return Array.from(new Set(tools.map((tool) => tool.name)));
};

// Configured names that exist in the catalog, in configured order, without
// duplicates. No configuration enables every tool.
const filterEnabledTools = (
	toolNames: string[],
	enabledTools = toolNames,
): string[] => {
	const available = new Set(toolNames);
	return Array.from(new Set(enabledTools)).filter((name) =>
		available.has(name),
	);
};

const isMethodNotFoundError = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) return false;
	return 'code' in error && error.code === -32601;
};

const createMcpUpstreamCatalog = (params: CreateMcpUpstreamCatalogParams) => {
	const compileInputSchema = createInputSchemaCompiler();
	const inputValidators = new WeakMap<Tool, CompiledSchema>();
	const {
		attemptReconnect,
		backends,
		config,
		configPath,
		markMcpUpstreamConfigurationError,
		setMcpUpstreamStatusError,
		trafficStore,
		waitForRateLimit,
	} = params;

	const initializeToolState = async (catalogParams: {
		server: McpUpstreamBackend;
		tools: Tool[];
	}): Promise<void> => {
		const toolNames = getToolNames(catalogParams.tools);
		let enabledTools = catalogParams.server.serverConfig.enabledTools;
		if (!enabledTools) {
			enabledTools = toolNames;
			catalogParams.server.serverConfig.enabledTools = enabledTools;
		}
		// A previously discovered tool disappearing is a catalog change, not a
		// configuration typo. Prune only those names; never silently accept an
		// enabledTools entry that has never appeared in this backend's catalog.
		// Use the persisted catalog too, so removals survive a restart/reconnect
		// that cleared the in-memory cache.
		const previousNames = new Set(
			catalogParams.server.serverConfig.availableTools ?? [],
		);
		const currentNames = new Set(toolNames);
		enabledTools = enabledTools.filter(
			(name) => !previousNames.has(name) || currentNames.has(name),
		);
		catalogParams.server.serverConfig.enabledTools = enabledTools;
		catalogParams.server.serverConfig.availableTools = toolNames;
		try {
			await saveToolState({
				configPath,
				config,
				serverName: catalogParams.server.serverName,
				enabledTools,
				availableTools: toolNames,
			});
		} catch (err) {
			logger.error(
				`Failed to persist tool state for "${catalogParams.server.serverName}": ${errorMessage(err)}`,
			);
		}
	};

	// Tools, prompts and resources share one fetch flow. Tools also compile their
	// schemas and persist exposure state. A failed fetch keeps the previous list,
	// which the caching spec permits. Returns true when a fetched list was stored.
	const fetchCatalog = async <T>(
		server: McpUpstreamBackend,
		options: {
			method: string;
			capability: 'tools' | 'prompts' | 'resources';
			empty: () => T;
			// undefined clears the list of a backend that does not advertise it.
			save: (result: T | undefined) => void;
			fetch: (client: Client) => Promise<T>;
			// Runs after caching; an awaited step may outlive this client.
			prepare?: (result: T, client: Client) => Promise<void>;
			// Returns true when the result is rejected and must not be logged as a
			// normal fetch.
			reject?: (result: T, client: Client) => boolean;
		},
	): Promise<boolean> => {
		const serverName = server.serverName;
		const client = server.client;
		if (!client) return false;
		// Both parties MUST only use negotiated capabilities.
		if (!client.getServerCapabilities()?.[options.capability]) {
			options.save(undefined);
			return false;
		}
		// A backend may be disabled or reconnected while a request is in flight.
		const isCurrent = (): boolean => server.client === client;
		try {
			await waitForRateLimit(server);
			if (!isCurrent()) return false;
			const result = await options.fetch(client);
			if (!isCurrent()) return false;
			options.save(result);
			await options.prepare?.(result, client);
			if (!isCurrent()) return false;
			if (options.reject?.(result, client)) return true;
			trafficStore?.logBackendTraffic({
				protocolVersion: client.protocolVersion,
				backend: serverName,
				method: options.method,
				request: {},
				response: result,
			});
			return true;
		} catch (error) {
			if (!isCurrent()) return false;
			if (isMethodNotFoundError(error)) {
				options.save(options.empty());
				logger.info(
					`MCP upstream "${serverName}" does not support ${options.method}`,
				);
				return true;
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
			return false;
		}
	};

	// Validate/compile once for each fetched catalog. Reads and calls only look up
	// the stored result; bad schemas never disable healthy siblings.
	const compileTools = (
		server: McpUpstreamBackend,
		client: Client,
		tools: Tool[],
	): void => {
		for (const tool of tools) {
			// Both modern HTTP hops need these rules. Cache successes and failures
			// once per fetched schema; the tool stays in the catalog, and these
			// annotations do not invalidate either 2025 contract.
			try {
				toolHeaderParameters(tool.inputSchema);
			} catch (error) {
				logger.warn(
					JSON.stringify({
						message:
							'Tool header annotations are invalid; tool unavailable over modern HTTP',
						context: {
							backend: server.serverName,
							tool: tool.name,
							protocolVersion: client.protocolVersion,
						},
						error: errorMessage(error),
					}),
				);
			}
			const compiled = compileInputSchema(tool.inputSchema);
			inputValidators.set(tool, compiled);
			if ('issue' in compiled)
				logger.warn(
					JSON.stringify({
						message:
							'Tool input schema is unusable; tool will not be exposed or invoked',
						context: {
							backend: server.serverName,
							tool: tool.name,
							protocolVersion: client.protocolVersion,
						},
						error: compiled.issue,
					}),
				);
		}
	};

	// enabledTools may only name tools this backend has listed.
	const rejectUnknownEnabledTools = (
		server: McpUpstreamBackend,
		client: Client,
		tools: Tool[],
	): boolean => {
		const toolNames = getToolNames(tools);
		const enabledTools = server.serverConfig.enabledTools ?? [];
		const unknown = Array.from(
			new Set(enabledTools.filter((name) => !toolNames.includes(name))),
		);
		if (unknown.length === 0) {
			server.configError = false;
			return false;
		}
		const error = `Configuration error: enabledTools has unknown tools: ${unknown.join(', ')}`;
		trafficStore?.logBackendTraffic({
			protocolVersion: client.protocolVersion,
			backend: server.serverName,
			method: 'tools/list:configuration_error',
			request: {
				enabledTools,
				availableTools: toolNames,
			},
			response: {
				error: {
					type: 'configuration_error',
					message: error,
					invalidEnabledTools: unknown,
				},
			},
		});
		markMcpUpstreamConfigurationError(server, error);
		return true;
	};

	const fetchTools = (server: McpUpstreamBackend): Promise<boolean> =>
		fetchCatalog(server, {
			method: 'tools/list',
			capability: 'tools',
			empty: emptyToolsResult,
			save: (result) => {
				server.tools = result;
			},
			fetch: (client) =>
				client.listTools(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
			prepare: async (result, client) => {
				compileTools(server, client, result.tools);
				await initializeToolState({
					server,
					tools: result.tools,
				});
			},
			reject: (result, client) =>
				rejectUnknownEnabledTools(server, client, result.tools),
		});
	const fetchPrompts = (server: McpUpstreamBackend): Promise<boolean> =>
		fetchCatalog(server, {
			method: 'prompts/list',
			capability: 'prompts',
			empty: emptyPromptsResult,
			save: (result) => {
				server.prompts = result;
			},
			fetch: (client) =>
				client.listPrompts(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
		});
	const fetchResources = (server: McpUpstreamBackend): Promise<boolean> =>
		fetchCatalog(server, {
			method: 'resources/list',
			capability: 'resources',
			empty: emptyResourcesResult,
			save: (result) => {
				server.resources = result;
			},
			fetch: (client) =>
				client.listResources(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
		});

	// Templates share the resources capability.
	const fetchResourceTemplates = (
		server: McpUpstreamBackend,
	): Promise<boolean> =>
		fetchCatalog(server, {
			method: 'resources/templates/list',
			capability: 'resources',
			empty: emptyResourceTemplatesResult,
			save: (result) => {
				server.resourceTemplates = result;
			},
			fetch: (client) =>
				client.listResourceTemplates(
					{},
					{
						timeout: server.serverConfig.timeout,
					},
				),
		});

	// Backends that have fetched the given catalog, in configuration order.
	const collect = <T>(
		select: (backend: McpUpstreamBackend) => T | undefined,
	): Map<string, T> => {
		const result = new Map<string, T>();
		for (const backend of backends.values()) {
			const value = select(backend);
			if (value) result.set(backend.serverName, value);
		}
		return result;
	};

	// MCP clients see only enabled backends without a configuration error.
	const collectEnabled = <T>(
		select: (backend: McpUpstreamBackend) => T | undefined,
	): Map<string, T> =>
		collect((backend) =>
			backend.serverConfig.enabled && !backend.configError
				? select(backend)
				: undefined,
		);

	const listAllTools = (): McpUpstreamToolsMap =>
		collect((backend) => backend.tools);

	const listAllPrompts = (): McpUpstreamPromptsMap =>
		collect((backend) => backend.prompts);

	const listAllResources = (): McpUpstreamResourcesMap =>
		collect((backend) => backend.resources);

	const listEnabledTools = (): McpUpstreamToolsMap =>
		collectEnabled((backend) => {
			if (!backend.tools) return undefined;
			const enabledSet = new Set(getEnabledTools(backend));
			return {
				...backend.tools,
				tools: backend.tools.tools.filter((tool) => {
					const compiled = inputValidators.get(tool);
					return (
						enabledSet.has(tool.name) &&
						compiled !== undefined &&
						'validate' in compiled
					);
				}),
			};
		});

	const listEnabledPrompts = (): McpUpstreamPromptsMap =>
		collectEnabled((backend) => backend.prompts);

	const listEnabledResources = (): McpUpstreamResourcesMap =>
		collectEnabled((backend) => backend.resources);

	const listEnabledResourceTemplates = (): McpUpstreamResourceTemplatesMap =>
		collectEnabled((backend) => backend.resourceTemplates);

	const getEnabledTools = (catalogParams: { serverName: string }): string[] => {
		const backend = backends.get(catalogParams.serverName);
		if (!backend) {
			return [];
		}
		return filterEnabledTools(
			getToolNames(backend.tools?.tools ?? []),
			backend.serverConfig.enabledTools,
		);
	};

	// A call needs the enabled tool and its compiled input schema: one lookup.
	const getEnabledTool = (catalogParams: {
		serverName: string;
		toolName: string;
	}): EnabledTool | undefined => {
		const backend = backends.get(catalogParams.serverName);
		const enabledTools = backend?.serverConfig.enabledTools;
		if (enabledTools && !enabledTools.includes(catalogParams.toolName))
			return undefined;
		const tool = backend?.tools?.tools.find(
			(tool) => tool.name === catalogParams.toolName,
		);
		return (
			tool && {
				tool,
				inputValidator: inputValidators.get(tool),
			}
		);
	};

	const toggleTool = async (
		catalogParams: ToggleToolParams,
	): Promise<string[]> => {
		const server = backends.get(catalogParams.serverName);
		if (!server) {
			throw new Error(
				`MCP upstream "${catalogParams.serverName}" is not available`,
			);
		}
		const toolNames = server.serverConfig.availableTools ?? [];
		if (!toolNames.includes(catalogParams.toolName)) {
			throw new Error(
				`Tool "${catalogParams.toolName}" is not available on MCP upstream "${catalogParams.serverName}"`,
			);
		}

		const currentSet = new Set(
			filterEnabledTools(toolNames, server.serverConfig.enabledTools),
		);
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
			await saveToolState({
				configPath,
				config,
				serverName: server.serverName,
				enabledTools: nextEnabled,
				availableTools: toolNames,
			});
			// nextEnabled only names listed tools, so this clears any
			// configuration error about unknown enabledTools.
			if (server.configError) {
				server.configError = false;
				await attemptReconnect(server);
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
		fetchResourceTemplates,
		fetchTools,
		getEnabledTools,
		listAllPrompts,
		listAllResources,
		listAllTools,
		listEnabledPrompts,
		listEnabledResources,
		listEnabledResourceTemplates,
		listEnabledTools,
		getEnabledTool,
		toggleTool,
	};
};

export { createMcpUpstreamCatalog };
