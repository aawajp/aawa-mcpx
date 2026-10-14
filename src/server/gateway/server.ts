import type {
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
} from '@modelcontextprotocol/sdk/types';

import { createClientActivityTracker } from '@/server/gateway/client_activity';
import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/server/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { createUiRoutes } from '@/server/gateway/ui_routes';
import { logger } from '@/server/logger';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import {
	CURRENT_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import indexHtml from '@/ui/index.html';

const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

const CLIENT_ACTIVITY_HISTORY_LIMIT = 200;

const SUPPORTED_GATEWAY_PROTOCOL_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS;
const DEFAULT_GATEWAY_PROTOCOL_VERSION = SUPPORTED_GATEWAY_PROTOCOL_VERSIONS[0];

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
		protocolHeaderName: MCP_PROTOCOL_VERSION_HEADER,
		maxSessionsPerClient,
		supportedProtocolVersions: SUPPORTED_GATEWAY_PROTOCOL_VERSIONS,
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
						: ({
								tools: [],
							} satisfies ListToolsResult),
					prompts:
						rawPrompts.get(status.serverName) ??
						({
							prompts: [],
						} satisfies ListPromptsResult),
					resources:
						rawResources.get(status.serverName) ??
						({
							resources: [],
						} satisfies ListResourcesResult),
				};
			});
		const clients = clientActivity.list();

		return {
			protocolVersion: DEFAULT_GATEWAY_PROTOCOL_VERSION,
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
				onRequestMetadata: (_metadata, client) => {
					clientActivity.observe(client, CURRENT_PROTOCOL_VERSION);
				},
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
