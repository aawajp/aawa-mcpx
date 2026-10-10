import { saveBackendEnabled } from '@/config/loader';
import { createMcpUpstreamCatalog } from '@/mcp_upstreams/catalog';
import {
	createMcpUpstreamBackend,
	createMcpUpstreamConnections,
} from '@/mcp_upstreams/connections';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import type {
	CatalogList,
	CatalogRequest,
	CreateMcpUpstreamManagerParams,
	McpUpstreamBackend,
	McpUpstreamManager,
} from '@/mcp_upstreams/types';
import { parsePrefix } from '@/shared/mcp_namespaces';
import { CURRENT_PROTOCOL_VERSION, recordOf } from '@/shared/mcp_protocol';

const CATALOG_LISTS: CatalogList[] = [
	'tools',
	'prompts',
	'resources',
];

// The list each catalog-dependent client request reads.
const REQUEST_LISTS: Record<string, CatalogList | undefined> = {
	'tools/list': 'tools',
	'tools/call': 'tools',
	'prompts/list': 'prompts',
	'resources/list': 'resources',
};

const createMcpUpstreamManager = (
	params: CreateMcpUpstreamManagerParams,
): McpUpstreamManager => {
	const { config, configPath, trafficStore } = params;
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
		configPath,
		markMcpUpstreamConfigurationError:
			connections.markMcpUpstreamConfigurationError,
		setMcpUpstreamStatusError: connections.setMcpUpstreamStatusError,
		trafficStore,
		waitForRateLimit: connections.waitForRateLimit,
	});
	const fetchList: Record<
		CatalogList,
		(backend: McpUpstreamBackend) => Promise<boolean>
	> = {
		tools: catalog.fetchTools,
		prompts: catalog.fetchPrompts,
		resources: catalog.fetchResources,
	};
	// Each list is cached on its own. Concurrent requests share one fetch per
	// list; a list without ttlMs is stale at once and re-fetched on next access.
	const refreshList = async (
		backend: McpUpstreamBackend,
		list: CatalogList,
	): Promise<void> => {
		const pending = backend.listRefreshes[list];
		if (pending) return pending;
		const refresh = async (): Promise<void> => {
			const startedAt = Date.now();
			// A failed fetch keeps the stale list and its expiry.
			if (!(await fetchList[list](backend))) return;
			const ttl = Number(recordOf(backend[list])?.ttlMs ?? 0);
			backend.listExpiresAt[list] = startedAt + Math.max(0, ttl);
		};
		const promise = refresh();
		backend.listRefreshes[list] = promise;
		try {
			await promise;
		} finally {
			if (backend.listRefreshes[list] === promise)
				delete backend.listRefreshes[list];
		}
	};
	refreshCatalog = async (backend: McpUpstreamBackend): Promise<void> => {
		await Promise.allSettled(
			CATALOG_LISTS.map((list) => refreshList(backend, list)),
		);
	};
	// Re-fetch only the stale 2026-07-28 lists a client request reads: every
	// backend's list for a list method, the target backend's tools for a call.
	const refreshStaleCatalogs = async (
		request: CatalogRequest,
	): Promise<void> => {
		const list = REQUEST_LISTS[request.method];
		if (!list) return;
		let targets = Array.from(backends.values());
		if (request.method === 'tools/call') {
			const name = recordOf(request.params)?.name;
			let serverName: string;
			try {
				serverName = parsePrefix(String(name)).serverName;
			} catch {
				// The call itself reports the invalid name.
				return;
			}
			targets = targets.filter((backend) => backend.serverName === serverName);
		}
		await Promise.all(
			targets
				.filter(
					(backend) =>
						backend.status?.connected &&
						backend.status.protocolVersion === CURRENT_PROTOCOL_VERSION &&
						backend.client?.getServerCapabilities()?.[list] &&
						Date.now() >= backend.listExpiresAt[list],
				)
				.map((backend) => refreshList(backend, list)),
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
				await Promise.allSettled(Object.values(backend.listRefreshes));
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
			configPath,
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
