import { createClientActivityTracker } from '@/server/gateway/client_activity';
import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/server/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { createUiRoutes } from '@/server/gateway/ui_routes';
import { logger } from '@/server/logger';
import {
	emptyPromptsResult,
	emptyResourcesResult,
	emptyToolsResult,
} from '@/server/mcp_upstreams/catalog';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import {
	CURRENT_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import indexHtml from '@/ui/index.html';

const CLIENT_ACTIVITY_HISTORY_LIMIT = 200;

type StartServerParams = {
	port: number;
	development: boolean;
	maxSessionsPerClient: number;
	mcpUpstreamManager: McpUpstreamManager;
	trafficStore: TrafficStore;
	initialization?: Promise<void>;
};

type ServerInstance = {
	stop: () => Promise<void>;
};

const startServer = async (
	params: StartServerParams,
): Promise<ServerInstance> => {
	const {
		development,
		initialization = Promise.resolve(),
		maxSessionsPerClient,
		mcpUpstreamManager,
		port,
		trafficStore,
	} = params;
	const handlers = createHandlers({
		mcpUpstreamManager,
	});
	const clientActivity = createClientActivityTracker(
		CLIENT_ACTIVITY_HISTORY_LIMIT,
	);
	const mcpSessions = createMcpSessionManager({
		onClientActivity: clientActivity.observe,
		maxSessionsPerClient,
	});

	// All data is cached - no network calls, pure synchronous
	const buildOverview = () => {
		const rawTools = mcpUpstreamManager.listAllTools();
		const rawPrompts = mcpUpstreamManager.listAllPrompts();
		const rawResources = mcpUpstreamManager.listAllResources();
		const statuses = mcpUpstreamManager.getStatuses();

		const byName = (a: string, b: string) =>
			a.localeCompare(b, undefined, {
				sensitivity: 'base',
			});
		const backends = statuses
			.toSorted((a, b) => byName(a.serverName, b.serverName))
			.map((status) => {
				const tools = rawTools.get(status.serverName);
				return {
					...status,
					tools: tools
						? {
								...tools,
								tools: tools.tools.toSorted((a, b) => byName(a.name, b.name)),
							}
						: emptyToolsResult(),
					prompts: rawPrompts.get(status.serverName) ?? emptyPromptsResult(),
					resources:
						rawResources.get(status.serverName) ?? emptyResourcesResult(),
				};
			});
		const clients = clientActivity.list();

		return {
			protocolVersion: CURRENT_PROTOCOL_VERSION,
			supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			backends,
			clients,
		};
	};

	const routeRequest = createMcpRequestRouter({
		handlers,
		requireSession: mcpSessions.requireSession,
		handleInitialize: mcpSessions.handleInitialize,
	});
	const uiShutdownController = new AbortController();

	const server = Bun.serve({
		port,
		development: development
			? {
					hmr: true,
					console: true,
				}
			: false,
		routes: {
			'/mcp': createMcpHttpRoute({
				refreshCatalogs: mcpUpstreamManager.refreshStaleCatalogs,
				onClientActivity: clientActivity.observe,
				initialization,
				mcpSessions,
				routeRequest,
				trafficStore,
			}),
			...createUiRoutes({
				mcpUpstreamManager,
				buildOverview,
				shutdownSignal: uiShutdownController.signal,
				trafficStore,
			}),
			'/*': indexHtml,
		},
		error(err) {
			logger.error(`Gateway server error: ${errorMessage(err)}`);
			return new Response('Internal Server Error', {
				status: 500,
			});
		},
	});

	logger.info(`Gateway listening on http://localhost:${port}`);

	const stop = async () => {
		logger.info(
			`Stopping gateway, clearing ${mcpSessions.activeCount()} active session(s)`,
		);
		uiShutdownController.abort();
		await server.stop();
		mcpSessions.clear();
	};

	return {
		stop,
	};
};

export { startServer };
