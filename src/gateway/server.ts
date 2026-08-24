import type {
	JSONRPCErrorResponse,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import type { OutgoingJsonRpcResponse } from '@/gateway/json_rpc';
import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/gateway/mcp_http_route';
import {
	namespaceTool,
	parsePrefix,
	parseResourceUri,
} from '@/gateway/mcp_namespaces';
import {
	createMcpRequestRouter,
	namedArgumentsParamsType,
	resourceReadParamsType,
} from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import { createUiRoutes } from '@/gateway/ui_routes';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

import indexHtml from '../index.html';

// Header name per MCP SDK convention
const MCP_SESSION_HEADER = 'mcp-session-id';
const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const CLIENT_SESSION_HISTORY_LIMIT = 200;

// TODO: should confirm actual compatibility with each version
const SUPPORTED_GATEWAY_PROTOCOL_VERSIONS = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
] as const;
const DEFAULT_GATEWAY_PROTOCOL_VERSION = SUPPORTED_GATEWAY_PROTOCOL_VERSIONS[0];

const createJsonResponse = (
	body: OutgoingJsonRpcResponse,
	sessionId?: string,
	status?: number,
): Response => {
	const headers = new Headers({
		'Content-Type': 'application/json',
	});
	if (sessionId) {
		headers.set(MCP_SESSION_HEADER, sessionId);
	}
	return new Response(JSON.stringify(body), {
		status: status ?? 200,
		headers,
	});
};

const createNotificationResponse = (sessionId?: string): Response => {
	// Per MCP spec: notifications MUST return HTTP 202 Accepted with no body
	const headers = new Headers();
	if (sessionId) {
		headers.set(MCP_SESSION_HEADER, sessionId);
	}
	return new Response(null, {
		status: 202,
		headers,
	});
};

const createMethodNotAllowedResponse = (): Response => {
	return new Response(null, {
		status: 405,
		headers: {
			Allow: 'POST, DELETE',
		},
	});
};

const createOriginForbiddenResponse = (): Response => {
	const body = {
		jsonrpc: '2.0',
		id: undefined,
		error: {
			code: 403,
			message: 'Invalid Origin header.',
		},
	} satisfies OutgoingJsonRpcResponse;
	return createJsonResponse(body, undefined, 403);
};

const parseSessionId = (request: Request): string | undefined => {
	const headerSession = request.headers.get(MCP_SESSION_HEADER) ?? undefined;
	if (headerSession) {
		return headerSession;
	}
	return undefined;
};

const resolveNumberEnv = (key: string, fallback: number): number => {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
	const mcpSessions = createMcpSessionManager({
		historyLimit: CLIENT_SESSION_HISTORY_LIMIT,
		protocolHeaderName: MCP_PROTOCOL_VERSION_HEADER,
		sessionTtlMs: resolveNumberEnv(
			'MCP_SESSION_TTL_MS',
			DEFAULT_SESSION_TTL_MS,
		),
		sweepIntervalMs: resolveNumberEnv(
			'MCP_SESSION_SWEEP_INTERVAL_MS',
			DEFAULT_SESSION_SWEEP_INTERVAL_MS,
		),
		supportedProtocolVersions: SUPPORTED_GATEWAY_PROTOCOL_VERSIONS,
	});
	mcpSessions.startSweeper();

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
		const clients = mcpSessions.list();

		return {
			protocolVersion: DEFAULT_GATEWAY_PROTOCOL_VERSION,
			aggregated: {
				tools: aggregatedTools,
				prompts: prompts.prompts,
				resources: resources.resources,
			},
			backends,
			clients,
		};
	};

	const getHeaderValues = (value: string | null): string[] => {
		if (!value) return [];
		return value
			.split(',')
			.map((item) => item.trim().toLowerCase())
			.filter((item) => item !== '');
	};

	const acceptsContentType = (
		request: Request,
		contentType: string,
	): boolean => {
		const values = getHeaderValues(request.headers.get('accept'));
		return values.some((value) => {
			const [mediaType] = value.split(';');
			return mediaType === contentType || mediaType === '*/*';
		});
	};

	const isLocalHostname = (hostname: string): boolean => {
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '[::1]' ||
			hostname === '::1'
		);
	};

	const isValidOrigin = (request: Request): boolean => {
		const origin = request.headers.get('origin');
		if (!origin) return true;
		const host = request.headers.get('host');
		if (!host) return false;
		try {
			const originUrl = new URL(origin);
			const requestUrl = new URL(request.url);
			if (originUrl.host === host) return true;
			if (
				isLocalHostname(originUrl.hostname) &&
				isLocalHostname(requestUrl.hostname)
			) {
				return true;
			}
		} catch {
			return false;
		}
		return false;
	};

	const routeRequest = createMcpRequestRouter({
		handlers,
		requireSession: mcpSessions.requireSession,
		handleInitialize: mcpSessions.handleInitialize,
	});
	const uiShutdownController = new AbortController();

	const buildLogFields = (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	): string => {
		let message = `client=${mcpSessions.formatClient(sessionId, params)}`;
		message += `, session=${sessionId ?? 'none'}, method=${method}`;
		if (method === 'tools/call' && namedArgumentsParamsType.allows(params)) {
			const toolName = params.name;
			try {
				const { serverName, originalName } = parsePrefix(toolName);
				message += `, backend=${serverName}, tool=${originalName}`;
			} catch {
				message += `, tool=${toolName}`;
			}
		}
		if (method === 'prompts/get' && namedArgumentsParamsType.allows(params)) {
			const promptName = params.name;
			try {
				const { serverName, originalName } = parsePrefix(promptName);
				message += `, backend=${serverName}, prompt=${originalName}`;
			} catch {
				message += `, prompt=${promptName}`;
			}
		}
		if (method === 'resources/read' && resourceReadParamsType.allows(params)) {
			const uri = params.uri;
			try {
				const { serverName, originalUri } = parseResourceUri(uri);
				message += `, backend=${serverName}, resource=${originalUri}`;
			} catch {
				message += `, resource=${uri}`;
			}
		}
		return message;
	};

	const buildInboundMessageLog = (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	): string => {
		return `Message: ${buildLogFields(method, sessionId, params)}`;
	};

	const isJsonRpcErrorResponse = (
		payload: OutgoingJsonRpcResponse | null,
	): payload is JSONRPCErrorResponse => {
		return !!payload && 'error' in payload;
	};

	const logResponseError = (params: {
		method: string;
		sessionId: string | undefined;
		requestParams?: unknown;
		payload: OutgoingJsonRpcResponse | null;
		status?: number;
	}): void => {
		if (!isJsonRpcErrorResponse(params.payload) && !params.status) return;
		const status = params.status ? `, status=${params.status}` : '';
		if (!isJsonRpcErrorResponse(params.payload)) {
			logger.warn(
				`Response error: ${buildLogFields(params.method, params.sessionId, params.requestParams)}${status}`,
			);
			return;
		}
		logger.warn(
			`Response error: ${buildLogFields(params.method, params.sessionId, params.requestParams)}${status}, code=${params.payload.error.code}, message=${params.payload.error.message}`,
		);
	};

	const waitForInitialization = async (params: {
		method: string;
		sessionId: string | undefined;
		requestParams?: unknown;
		id?: string | number;
	}): Promise<Response | null> => {
		try {
			await initialization;
			return null;
		} catch (err) {
			const payload: OutgoingJsonRpcResponse = {
				jsonrpc: '2.0',
				id: params.id,
				error: {
					code: -32000,
					message: `Server initialization failed: ${errorMessage(err)}`,
				},
			};
			logResponseError({
				method: params.method,
				sessionId: params.sessionId,
				requestParams: params.requestParams,
				payload,
				status: 503,
			});
			return createJsonResponse(payload, params.sessionId, 503);
		}
	};

	const server = Bun.serve({
		port,
		routes: {
			'/mcp': createMcpHttpRoute({
				acceptsContentType,
				buildInboundMessageLog,
				buildLogFields,
				createJsonResponse,
				createMethodNotAllowedResponse,
				createNotificationResponse,
				createOriginForbiddenResponse,
				isValidOrigin,
				logResponseError,
				mcpSessions,
				parseSessionId,
				routeRequest,
				trafficStore,
				waitForInitialization,
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
		mcpSessions.stopSweeper();
		uiShutdownController.abort();
		await server.stop();
		mcpSessions.clear();
	};

	return {
		stop,
	};
};

export { type ServerInstance, type StartServerParams, startServer };
