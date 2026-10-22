import { createAccessRoutes } from '@/server/auth/access_routes';
import type { McpAuth } from '@/server/auth/mcp_auth';
import type { UiAuth } from '@/server/auth/ui_auth';
import type { AccessStore } from '@/server/db/access';
import type { TrafficStore } from '@/server/db/traffic';
import { createHostCheck, guardRoutes } from '@/server/gateway/allowed_hosts';
import { createClientActivityTracker } from '@/server/gateway/client_activity';
import { createHandlers } from '@/server/gateway/mcp_handlers';
import {
	createMcpForbiddenResponse,
	createMcpHttpRoute,
} from '@/server/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { createTesterRoutes } from '@/server/gateway/tester_routes';
import {
	createApiForbiddenResponse,
	createUiRoutes,
} from '@/server/gateway/ui_routes';
import {
	createUnknownRouteHandler,
	withTrailingSlashes,
} from '@/server/gateway/unknown_routes';
import { logger } from '@/server/logger';
import {
	emptyPromptsResult,
	emptyResourcesResult,
	emptyToolsResult,
} from '@/server/mcp_upstreams/catalog';
import { MESSAGE_SIZE_LIMIT } from '@/server/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';
import {
	CURRENT_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import { DASHBOARD_PATHS, UI_PAGE_PATHS, userLabel } from '@/shared/ui_api';
import indexHtml from '@/ui/index.html';

const CLIENT_ACTIVITY_HISTORY_LIMIT = 200;

type StartServerParams = {
	port: number;
	allowedHosts: readonly string[];
	development: boolean;
	maxSessionsPerClient: number;
	maxSessionsPerUser: number;
	mcpUpstreamManager: McpUpstreamManager;
	trafficStore: TrafficStore;
	// Without these (ENABLE_OIDC=false and ENABLE_SUPERADMIN=false) the
	// dashboard needs no login and /mcp no credentials.
	auth?: {
		ui: UiAuth;
		mcp: McpAuth;
		access: AccessStore;
	};
	initialization?: Promise<void>;
};

type ServerInstance = {
	// The listening port, chosen by the system for port 0.
	port: number;
	stop: () => Promise<void>;
};

const startServer = async (
	params: StartServerParams,
): Promise<ServerInstance> => {
	const {
		allowedHosts,
		development,
		initialization = Promise.resolve(),
		maxSessionsPerClient,
		maxSessionsPerUser,
		mcpUpstreamManager,
		port,
		trafficStore,
		auth,
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
		maxSessionsPerUser,
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
		const clients = clientActivity.list(
			auth
				? new Map(
						auth.access.listUsers().map((user) => [user.id, userLabel(user)]),
					)
				: undefined,
		);

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
	const isAllowedHost = createHostCheck(allowedHosts);
	// Probes call /api/health without a login.
	const { [DASHBOARD_PATHS.health]: healthRoute, ...dashboardRoutes } =
		createUiRoutes({
			mcpUpstreamManager,
			buildOverview,
			shutdownSignal: uiShutdownController.signal,
			trafficStore,
			isLoggedIn: auth?.ui.isLoggedIn,
		});
	const mcpRoute = createMcpHttpRoute({
		refreshCatalogs: mcpUpstreamManager.refreshStaleCatalogs,
		onClientActivity: clientActivity.observe,
		initialization,
		mcpSessions,
		routeRequest,
		trafficStore,
		authenticate: auth?.mcp.authenticate,
	});
	const appRoutes = {
		...dashboardRoutes,
		...createTesterRoutes({
			mcpRoute,
			auth,
		}),
	};
	const endpoints = withTrailingSlashes({
		...guardRoutes(
			{
				'/mcp': mcpRoute,
			},
			isAllowedHost,
			createMcpForbiddenResponse,
		),
		...guardRoutes(
			{
				[DASHBOARD_PATHS.health]: healthRoute,
				...(auth
					? {
							...auth.mcp.routes,
							...auth.ui.routes,
							...auth.ui.protect({
								...appRoutes,
								...createAccessRoutes(auth.access, auth.ui),
							}),
						}
					: appRoutes),
			},
			isAllowedHost,
			createApiForbiddenResponse,
		),
	});

	const server = Bun.serve({
		port,
		// Client requests share the backend message size limit; larger ones get HTTP 413.
		maxRequestBodySize: MESSAGE_SIZE_LIMIT,
		development: development
			? {
					hmr: true,
					console: true,
				}
			: false,
		routes: {
			'/': new Response(null, {
				status: 302,
				headers: {
					Location: UI_PAGE_PATHS.main,
				},
			}),
			...withTrailingSlashes({
				[UI_PAGE_PATHS.main]: indexHtml,
				[UI_PAGE_PATHS.debug]: indexHtml,
				[UI_PAGE_PATHS.login]: indexHtml,
			}),
			...endpoints,
			...guardRoutes(
				{
					'/*': createUnknownRouteHandler(endpoints),
				},
				isAllowedHost,
				createApiForbiddenResponse,
			),
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
		port: server.port ?? port,
		stop,
	};
};

export { startServer };
