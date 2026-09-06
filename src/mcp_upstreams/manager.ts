import { saveBackendEnabled } from '@/config/loader';
import { createMcpUpstreamCatalog } from '@/mcp_upstreams/catalog';
import { createMcpUpstreamConnections } from '@/mcp_upstreams/connections';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import type {
	CreateMcpUpstreamManagerParams,
	McpUpstreamClientsMap,
	McpUpstreamManager,
	McpUpstreamPromptsMap,
	McpUpstreamRequestQueue,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamStatus,
	McpUpstreamToolsMap,
} from '@/mcp_upstreams/types';
import { CURRENT_PROTOCOL_VERSION, recordOf } from '@/shared/mcp_protocol';

const createMcpUpstreamManager = (
	params: CreateMcpUpstreamManagerParams,
): McpUpstreamManager => {
	const { config, trafficStore } = params;
	const servers = new Map<string, McpUpstreamServer>(
		Object.entries(config.mcpServers).map(([serverName, serverConfig]) => [
			serverName,
			{
				serverName,
				serverConfig,
			},
		]),
	);
	const clients: McpUpstreamClientsMap = new Map();
	const toolsCache: McpUpstreamToolsMap = new Map();
	const promptsCache: McpUpstreamPromptsMap = new Map();
	const resourcesCache: McpUpstreamResourcesMap = new Map();
	const statuses = new Map<string, McpUpstreamStatus>();
	const reconnectTimers = new Map<string, Timer>();
	const requestQueues = new Map<string, McpUpstreamRequestQueue>();
	const healthCheckFailures = new Map<string, number>();
	const suppressClientErrorsUntil = new Map<string, number>();
	const configErrorBackends = new Set<string>();
	const catalogExpiresAt = new Map<string, number>();
	const catalogRefreshes = new Map<string, Promise<void>>();

	let refreshCatalog = async (_server: McpUpstreamServer): Promise<void> => {
		// Reassigned after the catalog is created; connection callbacks close over it.
	};

	const connections = createMcpUpstreamConnections({
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
		refreshCatalog: (server) => refreshCatalog(server),
	});
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: connections.attemptReconnect,
		clients,
		config,
		configErrorBackends,
		getServer: connections.getServer,
		markMcpUpstreamConfigurationError:
			connections.markMcpUpstreamConfigurationError,
		onValidationError: connections.onValidationError,
		promptsCache,
		resourcesCache,
		setMcpUpstreamStatusError: connections.setMcpUpstreamStatusError,
		toolsCache,
		trafficStore,
		waitForRateLimit: connections.waitForRateLimit,
	});
	refreshCatalog = async (server: McpUpstreamServer): Promise<void> => {
		// Multiple requests can observe the same expired 2026-07-28 catalog.
		// Share its refresh; each backend retains its own credential/cache context.
		const pending = catalogRefreshes.get(server.serverName);
		if (pending) return pending;
		const refresh = async (): Promise<void> => {
			const startedAt = Date.now();
			await Promise.allSettled([
				catalog.fetchTools(server),
				catalog.fetchPrompts(server),
				catalog.fetchResources(server),
			]);
			const results = [
				toolsCache.get(server.serverName),
				promptsCache.get(server.serverName),
				resourcesCache.get(server.serverName),
			];
			const ttl = Math.min(
				// The first catalog to expire makes the combined snapshot stale.
				...results.map((result) => Number(recordOf(result)?.ttlMs ?? 0)),
			);
			// A slower sibling catalog must not extend the freshness of an earlier result.
			catalogExpiresAt.set(server.serverName, startedAt + Math.max(0, ttl));
		};
		const promise = refresh();
		catalogRefreshes.set(server.serverName, promise);
		try {
			await promise;
		} finally {
			if (catalogRefreshes.get(server.serverName) === promise)
				catalogRefreshes.delete(server.serverName);
		}
	};
	const refreshStaleCatalogs = async (): Promise<void> => {
		await Promise.all(
			connections
				.getStatuses()
				.filter(
					(status) =>
						status.connected &&
						status.protocolVersion === CURRENT_PROTOCOL_VERSION &&
						Date.now() >= (catalogExpiresAt.get(status.serverName) ?? 0),
				)
				.map(async (status) => {
					const server = servers.get(status.serverName);
					if (server) await refreshCatalog(server);
				}),
		);
	};

	const operations = createMcpUpstreamOperations({
		clients,
		getEnabledTools: catalog.getEnabledTools,
		getServer: connections.getServer,
		onValidationError: connections.onValidationError,
		trafficStore,
		waitForRateLimit: connections.waitForRateLimit,
	});

	const toggleBackend = async (toggleParams: {
		serverName: string;
		enabled: boolean;
	}): Promise<void> => {
		const server = connections.getServer(toggleParams.serverName);
		if (!server) {
			throw new Error(`Unknown MCP upstream "${toggleParams.serverName}"`);
		}
		if (server.serverConfig.enabled === toggleParams.enabled) return;

		await saveBackendEnabled({
			config,
			...toggleParams,
		});
		await connections.setBackendEnabled(server, toggleParams.enabled);
	};

	return {
		refreshStaleCatalogs,
		initialize: connections.initialize,
		getClient: connections.getClient,
		getAllClients: connections.getAllClients,
		disconnect: connections.disconnect,
		listAllTools: catalog.listAllTools,
		listEnabledTools: catalog.listEnabledTools,
		listAllPrompts: catalog.listAllPrompts,
		listAllResources: catalog.listAllResources,
		getEnabledTools: catalog.getEnabledTools,
		toggleBackend,
		toggleTool: catalog.toggleTool,
		callTool: operations.callTool,
		getPrompt: operations.getPrompt,
		readResource: operations.readResource,
		getStatuses: connections.getStatuses,
	};
};

export { createMcpUpstreamManager };
