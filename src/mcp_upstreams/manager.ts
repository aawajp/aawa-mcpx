import { saveBackendEnabled } from '@/config/loader';
import { createMcpUpstreamCatalog } from '@/mcp_upstreams/catalog';
import {
	createMcpUpstreamBackend,
	createMcpUpstreamConnections,
} from '@/mcp_upstreams/connections';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import type {
	CreateMcpUpstreamManagerParams,
	McpUpstreamBackend,
	McpUpstreamManager,
} from '@/mcp_upstreams/types';
import { CURRENT_PROTOCOL_VERSION, recordOf } from '@/shared/mcp_protocol';

const createMcpUpstreamManager = (
	params: CreateMcpUpstreamManagerParams,
): McpUpstreamManager => {
	const { config, trafficStore } = params;
	const backends = new Map<string, McpUpstreamBackend>(
		Object.entries(config.mcpServers).map(([serverName, serverConfig]) => [
			serverName,
			createMcpUpstreamBackend({
				serverName,
				serverConfig,
			}),
		]),
	);

	let refreshCatalog = async (_backend: McpUpstreamBackend): Promise<void> => {
		// Reassigned after the catalog is created; connection callbacks close over it.
	};

	const connections = createMcpUpstreamConnections({
		backends,
		trafficStore,
		refreshCatalog: (backend) => refreshCatalog(backend),
	});
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: connections.attemptReconnect,
		backends,
		config,
		markMcpUpstreamConfigurationError:
			connections.markMcpUpstreamConfigurationError,
		setMcpUpstreamStatusError: connections.setMcpUpstreamStatusError,
		trafficStore,
		waitForRateLimit: connections.waitForRateLimit,
	});
	refreshCatalog = async (backend: McpUpstreamBackend): Promise<void> => {
		// Multiple requests can observe the same expired 2026-07-28 catalog.
		// Share its refresh; each backend retains its own credential/cache context.
		const pending = backend.catalogRefresh;
		if (pending) return pending;
		const refresh = async (): Promise<void> => {
			const startedAt = Date.now();
			await Promise.allSettled([
				catalog.fetchTools(backend),
				catalog.fetchPrompts(backend),
				catalog.fetchResources(backend),
			]);
			const results = [
				backend.tools,
				backend.prompts,
				backend.resources,
			];
			const ttl = Math.min(
				// The first catalog to expire makes the combined snapshot stale.
				...results.map((result) => Number(recordOf(result)?.ttlMs ?? 0)),
			);
			// A slower sibling catalog must not extend the freshness of an earlier result.
			backend.catalogExpiresAt = startedAt + Math.max(0, ttl);
		};
		const promise = refresh();
		backend.catalogRefresh = promise;
		try {
			await promise;
		} finally {
			if (backend.catalogRefresh === promise)
				backend.catalogRefresh = undefined;
		}
	};
	const refreshStaleCatalogs = async (): Promise<void> => {
		await Promise.all(
			Array.from(backends.values())
				.filter(
					(backend) =>
						backend.status?.connected &&
						backend.status.protocolVersion === CURRENT_PROTOCOL_VERSION &&
						Date.now() >= backend.catalogExpiresAt,
				)
				.map(refreshCatalog),
		);
	};
	const refreshCatalogs = async (refreshParams?: {
		serverName?: string;
	}): Promise<void> => {
		const serverName = refreshParams?.serverName;
		const names =
			serverName !== undefined
				? [
						serverName,
					]
				: Array.from(backends.values())
						.filter(
							(backend) =>
								backend.serverConfig.enabled && backend.status?.connected,
						)
						.map((backend) => backend.serverName);
		await Promise.all(
			names.map(async (name) => {
				const backend = backends.get(name);
				if (!backend) throw new Error(`Unknown MCP upstream "${name}"`);
				// A refresh already in flight may predate the button press. Wait for it,
				// then fetch again, bypassing TTL for both initialized and modern peers.
				await backend.catalogRefresh;
				if (!backend.serverConfig.enabled || !backend.client)
					throw new Error(`MCP upstream "${name}" is not available`);
				await refreshCatalog(backend);
			}),
		);
	};

	const operations = createMcpUpstreamOperations({
		getEnabledTools: catalog.getEnabledTools,
		getInputValidator: catalog.getInputValidator,
		getOutputSchema: ({ serverName, toolName }) =>
			backends
				.get(serverName)
				?.tools?.tools.find((tool) => tool.name === toolName)?.outputSchema,
		getBackend: connections.getBackend,
		trafficStore,
		waitForRateLimit: connections.waitForRateLimit,
	});

	const toggleBackend = async (toggleParams: {
		serverName: string;
		enabled: boolean;
	}): Promise<void> => {
		const server = connections.getBackend(toggleParams.serverName);
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
		refreshCatalogs,
		initialize: connections.initialize,
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
