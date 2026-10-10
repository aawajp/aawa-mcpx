import type {
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import { saveToolState } from '@/config/loader';
import type { McpConfig } from '@/config/schema';
import { createInputSchemaCompiler } from '@/mcp_upstreams/input_schema';
import type { CompiledSchema } from '@/mcp_upstreams/json_schema';
import type {
	Client,
	McpUpstreamBackend,
	McpUpstreamPromptsMap,
	McpUpstreamResourcesMap,
	McpUpstreamToolsMap,
	ToggleToolParams,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { toolHeaderParameters } from '@/shared/mcp_protocol';

type CreateMcpUpstreamCatalogParams = {
	attemptReconnect: (backend: McpUpstreamBackend) => Promise<void>;
	backends: Map<string, McpUpstreamBackend>;
	config: McpConfig;
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
	// schemas, persist exposure state, and keep their cache on runtime errors.
	const fetchCatalog = async <T>(
		server: McpUpstreamBackend,
		options: {
			method: string;
			capability: 'tools' | 'prompts' | 'resources';
			empty: () => T;
			// undefined clears the list of a backend that does not advertise it.
			save: (result: T | undefined) => void;
			fetch: (client: Client) => Promise<T>;
			keepCacheOnError?: boolean;
			// Runs after caching; an awaited step may outlive this client.
			prepare?: (result: T, client: Client) => Promise<void>;
			// Returns true when the result is rejected and must not be logged as a
			// normal fetch.
			reject?: (result: T, client: Client) => boolean;
			persist: (result: T) => void;
		},
	): Promise<T> => {
		const serverName = server.serverName;
		const client = server.client;
		if (!client) return options.empty();
		// Both parties MUST only use negotiated capabilities.
		if (!client.getServerCapabilities()?.[options.capability]) {
			options.save(undefined);
			return options.empty();
		}
		// A backend may be disabled or reconnected while a request is in flight.
		const isCurrent = (): boolean =>
			server.serverConfig.enabled && server.client === client;
		try {
			await waitForRateLimit(server);
			if (!isCurrent()) return options.empty();
			const result = await options.fetch(client);
			if (!isCurrent()) return options.empty();
			options.save(result);
			await options.prepare?.(result, client);
			if (!isCurrent()) return options.empty();
			if (options.reject?.(result, client)) return result;
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
			if (isMethodNotFoundError(error)) {
				options.save(empty);
				logger.info(
					`MCP upstream "${serverName}" does not support ${options.method}`,
				);
				return empty;
			}
			if (!options.keepCacheOnError) options.save(empty);
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

	// Validate/compile once for each fetched catalog. Reads and calls only look up
	// the stored result; bad schemas never disable healthy siblings.
	const compileTools = (
		server: McpUpstreamBackend,
		client: Client,
		tools: Tool[],
	): void => {
		for (const tool of tools) {
			// The public modern HTTP hop also needs rules for legacy/stdio
			// providers. Cache successes and failures once per fetched schema;
			// these annotations do not invalidate either 2025 contract.
			try {
				toolHeaderParameters(tool.inputSchema);
			} catch (error) {
				logger.warn(
					JSON.stringify({
						message:
							'Tool header annotations are invalid; tool unavailable to modern HTTP clients',
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

	const fetchTools = (server: McpUpstreamBackend): Promise<ListToolsResult> =>
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
			// Retain raw definitions for dashboard inspection and exposure settings:
			// an unusable schema is not a removed tool or a backend failure.
			keepCacheOnError: true,
			prepare: async (result, client) => {
				compileTools(server, client, result.tools);
				await initializeToolState({
					server,
					tools: result.tools,
				});
			},
			reject: (result, client) =>
				rejectUnknownEnabledTools(server, client, result.tools),
			persist: (result) =>
				trafficStore?.upsertTools({
					backend: server.serverName,
					tools: result.tools,
				}),
		});
	const fetchPrompts = (
		server: McpUpstreamBackend,
	): Promise<ListPromptsResult> =>
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
			persist: (result) =>
				trafficStore?.upsertPrompts({
					backend: server.serverName,
					prompts: result.prompts,
				}),
		});
	const fetchResources = (
		server: McpUpstreamBackend,
	): Promise<ListResourcesResult> =>
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
			persist: (result) =>
				trafficStore?.upsertResources({
					backend: server.serverName,
					resources: result.resources,
				}),
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

	const listAllTools = (): McpUpstreamToolsMap =>
		collect((backend) => backend.tools);

	const listEnabledTools = (): McpUpstreamToolsMap =>
		collect((backend) => {
			if (!backend.tools) return undefined;
			if (backend.configError)
				return {
					...backend.tools,
					tools: [],
				};
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

	const listAllPrompts = (): McpUpstreamPromptsMap =>
		collect((backend) => backend.prompts);

	const listAllResources = (): McpUpstreamResourcesMap =>
		collect((backend) => backend.resources);

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

	const getInputValidator = (catalogParams: {
		serverName: string;
		toolName: string;
	}): CompiledSchema | undefined => {
		const tool = backends
			.get(catalogParams.serverName)
			?.tools?.tools.find((tool) => tool.name === catalogParams.toolName);
		return tool ? inputValidators.get(tool) : undefined;
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
		const tools = server.tools?.tools ?? [];
		const toolNames = getToolNames(tools);
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
		fetchTools,
		getEnabledTools,
		listAllPrompts,
		listAllResources,
		listAllTools,
		listEnabledTools,
		getInputValidator,
		toggleTool,
	};
};

export { createMcpUpstreamCatalog };
