import type {
	JSONRPCErrorResponse,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResultResponse,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
} from '@modelcontextprotocol/sdk/types.d.ts';
import {
	isJSONRPCNotification,
	LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers/promises';

import { createHandlers } from '@/gateway/handlers';
import type { ServerInstance, StartServerParams } from '@/gateway/types';
import { logger } from '@/utils/logger';

import indexHtml from '../index.html';

// Header name per MCP SDK convention
const MCP_SESSION_HEADER = 'mcp-session-id';

// Incoming message type: either a request (with id) or notification (without id)
type IncomingMessage = JSONRPCRequest | JSONRPCNotification;

// Response types from SDK
type JsonRpcResponse = JSONRPCResultResponse | JSONRPCErrorResponse;

// Response type for route handlers
type RouteResult = {
	payload: JsonRpcResponse | null; // null for notifications (HTTP 202 with no body)
	sessionId?: string;
};

const createJsonResponse = (
	body: JsonRpcResponse,
	sessionId?: string,
): Response => {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	if (sessionId) {
		headers.set(MCP_SESSION_HEADER, sessionId);
	}
	return new Response(JSON.stringify(body), { headers });
};

const createNotificationResponse = (sessionId?: string): Response => {
	// Per MCP spec: notifications MUST return HTTP 202 Accepted with no body
	const headers = new Headers();
	if (sessionId) {
		headers.set(MCP_SESSION_HEADER, sessionId);
	}
	return new Response(null, { status: 202, headers });
};

const parseSessionId = (request: Request): string | undefined => {
	const headerSession = request.headers.get(MCP_SESSION_HEADER) ?? undefined;
	const url = new URL(request.url);
	const pathParts = url.pathname.split('/').filter(Boolean);
	if (headerSession) {
		return headerSession;
	}
	if (pathParts.length === 2 && pathParts[0] === 'mcp') {
		return pathParts[1];
	}
	return undefined;
};

const startServer = async (
	params: StartServerParams,
): Promise<ServerInstance> => {
	const { backendManager, port, trafficStore } = params;
	const handlers = createHandlers({ backendManager });
	const sessions = new Set<string>();

	// All data is cached - no network calls, pure synchronous
	const buildOverview = () => {
		// Namespaced for MCP clients
		const tools = handlers.listTools();
		const prompts = handlers.listPrompts();
		const resources = handlers.listResources();
		// Raw per-backend for UI
		const rawTools = backendManager.listAllTools();
		const rawPrompts = backendManager.listAllPrompts();
		const rawResources = backendManager.listAllResources();
		const statuses = backendManager.getStatuses();

		const backends = statuses.map((status) => ({
			...status,
			tools:
				rawTools.get(status.serverName) ??
				({ tools: [] } satisfies ListToolsResult),
			prompts:
				rawPrompts.get(status.serverName) ??
				({ prompts: [] } satisfies ListPromptsResult),
			resources:
				rawResources.get(status.serverName) ??
				({ resources: [] } satisfies ListResourcesResult),
		}));

		return {
			protocolVersion: LATEST_PROTOCOL_VERSION,
			aggregated: {
				tools: tools.tools,
				prompts: prompts.prompts,
				resources: resources.resources,
			},
			backends,
		};
	};

	const parsePagination = (url: string) => {
		const search = new URL(url).searchParams;
		const limitRaw = Number(search.get('limit'));
		const offsetRaw = Number(search.get('offset'));
		const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
		const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
		return { limit, offset, search };
	};

	const handleInitialize = async (
		request: JSONRPCRequest,
	): Promise<RouteResult> => {
		const sessionId = randomUUID();
		sessions.add(sessionId);

		return {
			sessionId,
			payload: {
				jsonrpc: '2.0',
				id: request.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					serverInfo: { name: 'aawa-mcpx', version: '1.0.0' },
					capabilities: { tools: {}, prompts: {}, resources: {} },
				},
			},
		};
	};

	const requireSession = (
		sessionId: string | undefined,
		id: string | number | undefined,
	): RouteResult | null => {
		if (!sessionId) {
			return {
				payload: {
					jsonrpc: '2.0',
					id: id,
					error: { code: 400, message: 'Missing MCP session' },
				},
			};
		}
		if (!sessions.has(sessionId)) {
			return {
				payload: {
					jsonrpc: '2.0',
					id: id,
					error: { code: 404, message: 'Unknown MCP session' },
				},
			};
		}
		return null;
	};

	// Route requests (have id, expect response) - all non-notification methods
	const routeRequest = async (
		request: JSONRPCRequest,
		sessionId: string | undefined,
	): Promise<RouteResult> => {
		switch (request.method) {
			case 'initialize':
				return await handleInitialize(request);
			case 'tools/list': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const result = handlers.listTools();
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			case 'prompts/list': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const result = handlers.listPrompts();
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			case 'resources/list': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const result = handlers.listResources();
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			case 'tools/call': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const params = request.params ?? {};
				const name = typeof params.name === 'string' ? params.name : '';
				const args =
					params &&
					typeof params === 'object' &&
					'arguments' in params &&
					typeof params.arguments === 'object'
						? (params.arguments as Record<string, unknown>)
						: {};
				const result = await handlers.callTool({ name, args });
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			case 'prompts/get': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const params = request.params ?? {};
				const name = typeof params.name === 'string' ? params.name : '';
				const args =
					params &&
					typeof params === 'object' &&
					'arguments' in params &&
					typeof params.arguments === 'object'
						? (params.arguments as Record<string, unknown>)
						: {};
				const result = await handlers.getPrompt({ name, args });
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			case 'resources/read': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				const params = request.params ?? {};
				const uri = typeof params.uri === 'string' ? params.uri : '';
				const result = await handlers.readResource({ uri });
				return {
					payload: { jsonrpc: '2.0', id: request.id, result },
					sessionId,
				};
			}
			// Resource templates - not supported, return empty list
			case 'resources/templates/list': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: { resourceTemplates: [] },
					},
					sessionId,
				};
			}
			// Resource subscriptions - not supported
			case 'resources/subscribe':
			case 'resources/unsubscribe': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32601,
							message: 'Resource subscriptions not supported',
						},
					},
					sessionId,
				};
			}
			// Completion - not supported
			case 'completion/complete': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: { completion: { values: [], hasMore: false } },
					},
					sessionId,
				};
			}
			// Logging - not supported
			case 'logging/setLevel': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: { jsonrpc: '2.0', id: request.id, result: {} },
					sessionId,
				};
			}
			// Tasks - not supported, return empty/error
			case 'tasks/list': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: { tasks: [] },
					},
					sessionId,
				};
			}
			case 'tasks/get':
			case 'tasks/result':
			case 'tasks/cancel': {
				const invalid = requireSession(sessionId, request.id);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: { code: -32601, message: 'Tasks not supported' },
					},
					sessionId,
				};
			}
			// Sampling - client-side capability, return error
			case 'sampling/createMessage': {
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: { code: -32601, message: 'Sampling not supported' },
					},
					sessionId,
				};
			}
			// Elicitation - not supported
			case 'elicitation/create': {
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: { code: -32601, message: 'Elicitation not supported' },
					},
					sessionId,
				};
			}
			// Ping for health check
			case 'ping': {
				return {
					payload: { jsonrpc: '2.0', id: request.id, result: {} },
					sessionId,
				};
			}
			default:
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32601,
							message: `Method not found: ${request.method}`,
						},
					},
					sessionId,
				};
		}
	};

	// Route notifications (no id, no response body, HTTP 202)
	const routeNotification = (
		_notification: JSONRPCNotification,
		sessionId: string | undefined,
	): RouteResult => {
		// All notifications return null payload for HTTP 202 with no body
		return { payload: null, sessionId };
	};

	const server = Bun.serve({
		port,
		routes: {
			'/mcp': {
				async POST(request) {
					let body: IncomingMessage;
					try {
						body = (await request.json()) as IncomingMessage;
					} catch (error) {
						return createJsonResponse({
							jsonrpc: '2.0',
							id: undefined,
							error: {
								code: -32700,
								message: `Invalid JSON: ${(error as Error).message}`,
							},
						});
					}
					if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
						// For invalid requests, try to extract id if it exists
						const maybeId =
							'id' in body ? (body as JSONRPCRequest).id : undefined;
						return createJsonResponse({
							jsonrpc: '2.0',
							id: maybeId,
							error: { code: -32600, message: 'Invalid JSON-RPC request' },
						});
					}
					const sessionId = parseSessionId(request);

					// Distinguish between requests and notifications using type guard
					if (isJSONRPCNotification(body)) {
						// Notification: no id, no response body, HTTP 202
						const notification = body as JSONRPCNotification;
						const routeResult = routeNotification(notification, sessionId);
						trafficStore.logClientTraffic({
							sessionId: routeResult.sessionId ?? sessionId,
							method: notification.method,
							request: notification,
							response: null,
						});
						return createNotificationResponse(
							routeResult.sessionId ?? sessionId,
						);
					}

					// Request: has id, expects JSON response
					const jsonRpcRequest = body as JSONRPCRequest;
					try {
						const routeResult = await routeRequest(jsonRpcRequest, sessionId);
						// routeResult.payload is always non-null for requests
						const response = createJsonResponse(
							routeResult.payload as JsonRpcResponse,
							routeResult.sessionId ?? sessionId,
						);
						trafficStore.logClientTraffic({
							sessionId: routeResult.sessionId ?? sessionId,
							method: jsonRpcRequest.method,
							request: jsonRpcRequest,
							response: routeResult.payload,
						});
						return response;
					} catch (error) {
						logger.error(`Handler error: ${(error as Error).message}`);
						trafficStore.logClientTraffic({
							sessionId,
							method: jsonRpcRequest.method,
							request: jsonRpcRequest,
							response: { error: (error as Error).message },
						});
						return createJsonResponse({
							jsonrpc: '2.0',
							id: jsonRpcRequest.id,
							error: { code: -32000, message: 'Internal server error' },
						});
					}
				},
				async DELETE(request) {
					const sessionId = parseSessionId(request);
					if (sessionId && sessions.has(sessionId)) {
						sessions.delete(sessionId);
						return new Response(null, { status: 202 });
					}
					return new Response('Session not found', { status: 404 });
				},
			},
			'/ui/overview': {
				GET() {
					try {
						const overview = buildOverview();
						return Response.json(overview);
					} catch (error) {
						logger.error(`UI overview error: ${(error as Error).message}`);
						return new Response('Internal Server Error', { status: 500 });
					}
				},
			},
			'/ui/events': {
				async GET(request) {
					const encoder = new TextEncoder();
					const controllerState = { closed: false };
					const abortController = new AbortController();
					let closeStream: (() => void) | null = null;
					const stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							let lastPayload = '';

							closeStream = () => {
								if (controllerState.closed) return;
								controllerState.closed = true;
								abortController.abort();
								try {
									controller.close();
								} catch {
									// already closed
								}
							};

							const handleAbort = () => {
								closeStream?.();
							};

							request.signal.addEventListener('abort', handleAbort);

							const sendIfChanged = () => {
								if (controllerState.closed) return;
								const overview = buildOverview();
								if (controllerState.closed) return;
								const payload = JSON.stringify(overview);
								if (payload === lastPayload) return;
								try {
									controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
									lastPayload = payload;
								} catch (error) {
									closeStream?.();
									throw error;
								}
							};

							try {
								sendIfChanged();
								for await (const _ of setInterval(2000, undefined, {
									signal: abortController.signal,
								})) {
									if (controllerState.closed) break;
									sendIfChanged();
								}
							} catch (error) {
								if ((error as Error).name !== 'AbortError') {
									logger.warn(
										`UI event stream send failed: ${(error as Error).message}`,
									);
								}
							} finally {
								request.signal.removeEventListener('abort', handleAbort);
								closeStream?.();
							}
						},
						cancel() {
							closeStream?.();
						},
					});

					return new Response(stream, {
						headers: {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							Connection: 'keep-alive',
							'X-Accel-Buffering': 'no',
						},
					});
				},
			},
			'/debug': {
				async GET(request) {
					try {
						const { limit, offset } = parsePagination(request.url);
						const client = trafficStore.getClientTraffic({ limit, offset });
						const statuses = backendManager.getStatuses();
						const backendResults = statuses
							.map((status) => status.serverName)
							.sort((a, b) => a.localeCompare(b))
							.map((backend) => ({
								backend,
								data: trafficStore.getBackendTraffic({
									backend,
									limit,
									offset,
								}),
							}));

						return Response.json({
							client,
							backends: backendResults,
						});
					} catch (error) {
						logger.error(`Debug endpoint error: ${(error as Error).message}`);
						return new Response('Internal Server Error', { status: 500 });
					}
				},
			},
			'/debug/client': {
				async GET(request) {
					const { limit, offset } = parsePagination(request.url);
					try {
						const client = trafficStore.getClientTraffic({ limit, offset });
						return Response.json(client);
					} catch (error) {
						logger.error(`Debug client error: ${(error as Error).message}`);
						return new Response('Internal Server Error', { status: 500 });
					}
				},
			},
			'/debug/backend': {
				async GET(request) {
					const { limit, offset, search } = parsePagination(request.url);
					const backend = search.get('backend');
					const method = search.get('method') ?? undefined;
					if (!backend) {
						return new Response('Missing backend parameter', { status: 400 });
					}
					try {
						const data = trafficStore.getBackendTraffic({
							backend,
							method: method && method.trim() !== '' ? method : undefined,
							limit,
							offset,
						});
						return Response.json({ backend, method, ...data });
					} catch (error) {
						logger.error(`Debug backend error: ${(error as Error).message}`);
						return new Response('Internal Server Error', { status: 500 });
					}
				},
			},
			'/health': {
				async GET() {
					const backends = backendManager.getStatuses();
					const healthy = backends.every((backend) => backend.connected);
					return Response.json({
						status: healthy ? 'ok' : 'degraded',
						backends,
					});
				},
			},
			'/*': indexHtml,
		},
		error(error) {
			logger.error(`Gateway server error: ${(error as Error).message}`);
			return new Response('Internal Server Error', { status: 500 });
		},
	});

	logger.info(`Gateway listening on http://localhost:${port}`);

	const stop = async () => {
		server.stop();
		sessions.clear();
	};

	return { stop };
};

export { startServer };
