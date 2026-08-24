import { saveBackendEnabled } from '@/config/loader';
import { createMcpUpstreamCatalog } from '@/mcp_upstreams/catalog';
import { createMcpUpstreamConnections } from '@/mcp_upstreams/connections';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import type { McpUpstreamTransport } from '@/mcp_upstreams/transport';
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
	const transports = new Map<string, McpUpstreamTransport>();
	const toolsCache: McpUpstreamToolsMap = new Map();
	const promptsCache: McpUpstreamPromptsMap = new Map();
	const resourcesCache: McpUpstreamResourcesMap = new Map();
	const statuses = new Map<string, McpUpstreamStatus>();
	const reconnectTimers = new Map<string, Timer>();
	const requestQueues = new Map<string, McpUpstreamRequestQueue>();
	const healthCheckFailures = new Map<string, number>();
	const suppressClientErrorsUntil = new Map<string, number>();
	const configErrorBackends = new Set<string>();

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
		transports,
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
		await Promise.allSettled([
			catalog.fetchTools(server),
			catalog.fetchPrompts(server),
			catalog.fetchResources(server),
		]);
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
