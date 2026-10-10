import type {
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import { createClientActivityTracker } from '@/server/gateway/client_activity';
import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/server/gateway/mcp_http_route';
import { namespaceTool } from '@/server/gateway/mcp_namespaces';
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

const DEFAULT_MAX_SESSIONS_PER_CLIENT = 10;
const CLIENT_ACTIVITY_HISTORY_LIMIT = 200;

const SUPPORTED_GATEWAY_PROTOCOL_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS;
const DEFAULT_GATEWAY_PROTOCOL_VERSION = SUPPORTED_GATEWAY_PROTOCOL_VERSIONS[0];

const resolveNumberEnv = (key: string, fallback: number): number => {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

type StartServerParams = {
	port: number;
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
		initialization = Promise.resolve(),
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
		maxSessionsPerClient: resolveNumberEnv(
			'MCP_MAX_SESSIONS_PER_CLIENT',
			DEFAULT_MAX_SESSIONS_PER_CLIENT,
		),
		supportedProtocolVersions: SUPPORTED_GATEWAY_PROTOCOL_VERSIONS,
	});

	// All data is cached - no network calls, pure synchronous
	const buildOverview = () => {
		const prompts = handlers.listPrompts();
		const resources = handlers.listResources();
		const rawTools = mcpUpstreamManager.listAllTools();
		const rawPrompts = mcpUpstreamManager.listAllPrompts();
		const rawResources = mcpUpstreamManager.listAllResources();
		const statuses = mcpUpstreamManager.getStatuses();
		const aggregatedTools: Array<
			Tool & {
				enabled: boolean;
			}
		> = [];

		for (const [serverName, toolsResult] of rawTools) {
			const enabledTools = new Set(
				mcpUpstreamManager.getEnabledTools({
					serverName,
				}),
			);
			for (const tool of toolsResult.tools) {
				aggregatedTools.push({
					...namespaceTool({
						serverName,
						tool,
					}),
					enabled: enabledTools.has(tool.name),
				});
			}
		}

		const backends = statuses.map((status) => ({
			...status,
			tools:
				rawTools.get(status.serverName) ??
				({
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
		}));
		const clients = clientActivity.list();

		return {
			protocolVersion: DEFAULT_GATEWAY_PROTOCOL_VERSION,
			supportedProtocolVersions: [
				...SUPPORTED_PROTOCOL_VERSIONS,
			],
			aggregated: {
				tools: aggregatedTools,
				prompts: prompts.prompts,
				resources: resources.resources,
			},
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
		routes: {
			'/mcp': createMcpHttpRoute({
				refreshCatalogs: mcpUpstreamManager.refreshStaleCatalogs,
				onRequestMetadata: (_metadata, client) => {
					clientActivity.observe(client, CURRENT_PROTOCOL_VERSION);
				},
				getToolSchema: (name) => handlers.findTool(name)?.inputSchema,
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
