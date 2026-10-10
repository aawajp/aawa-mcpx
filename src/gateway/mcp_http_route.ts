import { type } from 'arktype';

import {
	getJsonRpcId,
	type IncomingJsonRpcRequest,
	isIncomingJsonRpcNotification,
	isIncomingJsonRpcResponse,
	isJsonRpcErrorResponse,
	type OutgoingJsonRpcResponse,
	parseIncomingJsonRpcMessage,
	type RouteResult,
} from '@/gateway/json_rpc';
import type { createMcpSessionManager } from '@/gateway/mcp_session';
import type { CatalogRequest } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { withCancellation } from '@/shared/cancellation';
import type { ClientInfo } from '@/shared/client_info';
import { errorMessage } from '@/shared/common';
import { requestMetadataType } from '@/shared/mcp_metadata';
import {
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	decodeHeaderValue,
	PROTOCOL_VERSION_META,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
	validateToolHeaders,
} from '@/shared/mcp_protocol';

type ClientTrafficEntry = Parameters<TrafficStore['logClientTraffic']>[0] & {
	sessionId?: string;
};

type McpSessionManager = ReturnType<typeof createMcpSessionManager>;

type RouteRequest = (
	request: IncomingJsonRpcRequest,
	sessionId: string | undefined,
	protocolVersion?: string,
	mirroredHeaders?: Record<string, string>,
	signal?: AbortSignal,
) => Promise<RouteResult>;

const cancelledParamsType = type({
	requestId: 'string | number.integer',
	'reason?': 'string',
	'[string]': 'unknown',
});

// A cancelled RPC must not produce a result/error. End an empty SSE response
// instead: both HTTP bindings allow SSE for requests, while 202 is reserved for
// accepted notifications/responses. Disconnected callers receive no messages.
const createCancelledResponse = (): Response =>
	new Response('', {
		headers: {
			'Content-Type': 'text/event-stream',
		},
	});

type LogResponseError = (params: {
	method: string;
	sessionId: string | undefined;
	requestParams?: unknown;
	payload: OutgoingJsonRpcResponse | null;
	status?: number;
}) => void;

type CreateMcpHttpRouteParams = {
	acceptsContentType: (request: Request, contentType: string) => boolean;
	buildInboundMessageLog: (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	) => string;
	buildLogFields: (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	) => string;
	createJsonResponse: (
		body: OutgoingJsonRpcResponse,
		sessionId?: string,
		status?: number,
	) => Response;
	createMethodNotAllowedResponse: () => Response;
	createNotificationResponse: (sessionId?: string) => Response;
	createOriginForbiddenResponse: () => Response;
	isValidOrigin: (request: Request) => boolean;
	logResponseError: LogResponseError;
	mcpSessions: McpSessionManager;
	parseSessionId: (request: Request) => string | undefined;
	routeRequest: RouteRequest;
	trafficStore: TrafficStore;
	getToolSchema?: (name: string) => unknown;
	onRequestMetadata?: (
		metadata: Record<string, unknown>,
		client?: ClientInfo,
	) => void;
	refreshCatalogs?: (request: CatalogRequest) => Promise<void>;
	waitForInitialization: (params: {
		method: string;
		sessionId: string | undefined;
		requestParams?: unknown;
		id?: string | number;
	}) => Promise<Response | null>;
};

const createMcpHttpRoute = (params: CreateMcpHttpRouteParams) => {
	const {
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
	} = params;
	// Legacy IDs are scoped to a session, and number/string IDs remain distinct.
	// Initialize cannot be cancelled. Modern HTTP has no shared session/ID scope:
	// only the signal of that request's own connection can cancel its work.
	const activeRequests = new Map<
		string,
		Map<string | number, AbortController>
	>();
	const routeCancellableRequest = async (
		message: IncomingJsonRpcRequest,
		sessionId: string | undefined,
		version?: string,
		mirrors?: Record<string, string>,
		disconnect?: AbortSignal,
	): Promise<RouteResult> => {
		const controller = new AbortController();
		const signal =
			version === CURRENT_PROTOCOL_VERSION ? disconnect : controller.signal;
		const tracksId =
			sessionId !== undefined &&
			message.method !== 'initialize' &&
			version !== CURRENT_PROTOCOL_VERSION;
		let requests =
			sessionId === undefined ? undefined : activeRequests.get(sessionId);
		if (tracksId) {
			if (requests?.has(message.id))
				return {
					payload: {
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32600,
							message: 'Request ID is already in progress',
						},
					},
					status: 400,
				};
			if (!requests) {
				requests = new Map();
				activeRequests.set(sessionId, requests);
			}
			requests.set(message.id, controller);
		}
		try {
			signal?.throwIfAborted();
			return await withCancellation(
				routeRequest(
					message,
					sessionId,
					version,
					mirrors,
					message.method === 'initialize' ? undefined : signal,
				),
				signal,
			);
		} catch (error) {
			if (!signal?.aborted) throw error;
			// Cancellation has no JSON-RPC error code/result.
			return {
				payload: null,
				sessionId,
			};
		} finally {
			if (tracksId) {
				requests?.delete(message.id);
				if (requests?.size === 0) activeRequests.delete(sessionId);
			}
		}
	};
	const getTrafficProtocolVersion = (
		entry: ClientTrafficEntry,
	): string | undefined => {
		if (entry.protocolVersion !== undefined) return entry.protocolVersion;

		// For 2025-11-25 and 2025-06-18 initialization, log the selected
		// response version: it can differ from the client's proposal.
		const response = recordOf(entry.response);
		const result = recordOf(response?.result);
		if (typeof result?.protocolVersion === 'string')
			return result.protocolVersion;

		// 2026-07-28 carries its version on each request, without a session.
		const request = recordOf(entry.request);
		const requestParams = recordOf(request?.params);
		const metadata = recordOf(requestParams?._meta);
		const requestVersion = metadata?.[PROTOCOL_VERSION_META];
		if (typeof requestVersion === 'string') return requestVersion;

		// Later 2025-11-25 / 2025-06-18 messages use the initialized session.
		return mcpSessions.getProtocolVersion(entry.sessionId);
	};
	const logClientTraffic = (entry: ClientTrafficEntry): void => {
		const requestParams = recordOf(recordOf(entry.request)?.params);
		const metadata = recordOf(requestParams?._meta);
		const client =
			entry.protocolVersion === CURRENT_PROTOCOL_VERSION
				? recordOf(metadata?.[CLIENT_INFO_META])
				: mcpSessions.getClient(entry.sessionId);
		const name = typeof client?.name === 'string' ? client.name : 'unknown';
		const version =
			typeof client?.version === 'string' ? client.version : 'unknown';
		// Store the version now so subsequent session changes cannot rewrite history.
		trafficStore.logClientTraffic({
			client: `${name}@${version}`,
			method: entry.method,
			request: entry.request,
			response: entry.response,
			protocolVersion: getTrafficProtocolVersion(entry),
		});
	};

	return {
		GET(request: Request) {
			if (!isValidOrigin(request)) return createOriginForbiddenResponse();
			return createMethodNotAllowedResponse();
		},
		async POST(request: Request) {
			if (!isValidOrigin(request)) return createOriginForbiddenResponse();
			const sessionId = parseSessionId(request);
			if (
				!acceptsContentType(request, 'application/json') ||
				!acceptsContentType(request, 'text/event-stream')
			) {
				const payload: OutgoingJsonRpcResponse = {
					jsonrpc: '2.0',
					id: undefined,
					error: {
						code: 400,
						message:
							'MCP HTTP POST requests must accept application/json and text/event-stream.',
					},
				};
				logResponseError({
					method: 'unknown',
					sessionId,
					payload,
					status: 400,
				});
				return createJsonResponse(payload, sessionId, 400);
			}
			let rawBody: unknown;
			try {
				rawBody = await request.json();
			} catch (err) {
				const payload: OutgoingJsonRpcResponse = {
					jsonrpc: '2.0',
					id: undefined,
					error: {
						code: -32700,
						message: `Invalid JSON: ${errorMessage(err)}`,
					},
				};
				logResponseError({
					method: 'unknown',
					sessionId,
					payload,
					status: 400,
				});
				return createJsonResponse(payload, sessionId, 400);
			}
			const message = parseIncomingJsonRpcMessage(rawBody);
			if (!message) {
				const record = recordOf(rawBody);
				const maybeId =
					record && 'id' in record
						? (getJsonRpcId(record.id) ?? undefined)
						: undefined;
				const method =
					typeof record?.method === 'string' ? record.method : 'unknown';
				const payload: OutgoingJsonRpcResponse = {
					jsonrpc: '2.0',
					id: maybeId,
					error: {
						code: -32600,
						message: 'Invalid JSON-RPC message',
					},
				};
				logResponseError({
					method,
					sessionId,
					requestParams: record?.params,
					payload,
					status: 400,
				});
				return createJsonResponse(payload, sessionId, 400);
			}

			const metadata = recordOf(recordOf(message.params)?._meta);
			const versionHeader = request.headers.get('MCP-Protocol-Version');
			// Classify before session validation: 2026-07-28 requests ignore session
			// IDs. Unknown newer revisions also reach the explicit version error path.
			if (
				('method' in message && message.method === 'server/discover') ||
				(metadata && PROTOCOL_VERSION_META in metadata) ||
				versionHeader === CURRENT_PROTOCOL_VERSION ||
				(versionHeader && versionHeader > '2025-11-25')
			) {
				const fail = (
					code: number,
					text: string,
					data?: Record<string, unknown>,
				): Response =>
					createJsonResponse(
						{
							jsonrpc: '2.0',
							id: message.id,
							error: {
								code,
								message: text,
								data,
							},
						},
						undefined,
						code === -32603 ? 500 : 400,
					);
				if (
					isIncomingJsonRpcNotification(message) ||
					isIncomingJsonRpcResponse(message)
				)
					return fail(-32600, 'MCP 2026-07-28 HTTP accepts requests only');
				// Validate the request's own metadata before comparing mirrors. Missing
				// fields are InvalidParams, not a version/header negotiation failure.
				if (!requestMetadataType.allows(metadata))
					return fail(-32602, 'Missing or malformed request metadata');
				const version = metadata[PROTOCOL_VERSION_META];
				if (!versionHeader || versionHeader !== version)
					return fail(-32020, 'Missing or mismatched protocol version header');
				if (version !== CURRENT_PROTOCOL_VERSION)
					return fail(-32022, 'Unsupported protocol version', {
						requested: version,
						supported: [
							...SUPPORTED_PROTOCOL_VERSIONS,
						],
					});
				if (request.headers.get('Mcp-Method') !== message.method)
					return fail(-32020, 'Missing or mismatched Mcp-Method');
				const bodyParams = recordOf(message.params);
				if (
					[
						'tools/call',
						'prompts/get',
						'resources/read',
					].includes(message.method)
				) {
					const name =
						message.method === 'resources/read'
							? bodyParams?.uri
							: bodyParams?.name;
					try {
						const header = request.headers.get('Mcp-Name');
						if (header === null || decodeHeaderValue(header) !== name)
							return fail(-32020, 'Missing or mismatched Mcp-Name');
					} catch {
						return fail(-32020, 'Malformed Mcp-Name');
					}
				}
				if (
					[
						'tools/list',
						'tools/call',
						'prompts/list',
						'prompts/get',
						'resources/list',
						'resources/templates/list',
						'resources/read',
					].includes(message.method)
				) {
					// Refresh only catalog-dependent methods, once, before using header
					// rules. Discovery and unsupported methods need no backend work.
					try {
						request.signal.throwIfAborted();
						const unavailable = await withCancellation(
							waitForInitialization({
								method: message.method,
								sessionId: undefined,
								id: message.id,
							}),
							request.signal,
						);
						if (unavailable) return unavailable;
						await withCancellation(
							Promise.resolve(
								params.refreshCatalogs?.({
									method: message.method,
									params: message.params,
								}),
							),
							request.signal,
						);
					} catch (error) {
						if (request.signal.aborted) return createCancelledResponse();
						logger.error(
							JSON.stringify({
								message: 'MCP catalog refresh failed',
								context: {
									method: message.method,
								},
								error: errorMessage(error),
							}),
						);
						return fail(-32603, 'Internal server error');
					}
				}
				// Header rules were compiled at catalog fetch. Compare values directly
				// without encoding the body and decoding it again on every request.
				try {
					if (message.method === 'tools/call') {
						const issue = validateToolHeaders(
							request.headers,
							bodyParams?.arguments,
							params.getToolSchema?.(String(bodyParams?.name)),
						);
						if (issue) return fail(-32020, issue);
					}
				} catch {
					return fail(-32020, 'Invalid mirrored tool parameter');
				}
				// Metadata is already validated; activity tracking needs no second
				// parse/validation of client identity and grants it no capabilities.
				params.onRequestMetadata?.(metadata, metadata[CLIENT_INFO_META]);
				try {
					const result = await routeCancellableRequest(
						message,
						undefined,
						CURRENT_PROTOCOL_VERSION,
						// Unknown parameter mirrors remain opaque to this hop.
						Object.fromEntries(
							[
								...request.headers,
							].filter(([name]) => name.startsWith('mcp-param-')),
						),
						request.signal,
					);
					if (!result.payload) return createCancelledResponse();
					logClientTraffic({
						protocolVersion: CURRENT_PROTOCOL_VERSION,
						method: message.method,
						request: message,
						response: result.payload,
					});
					return createJsonResponse(
						result.payload as OutgoingJsonRpcResponse,
						undefined,
						result.status,
					);
				} catch {
					return createJsonResponse(
						{
							jsonrpc: '2.0',
							id: message.id,
							error: {
								code: -32603,
								message: 'Internal server error',
							},
						},
						undefined,
						500,
					);
				}
			}

			if (isIncomingJsonRpcNotification(message)) {
				const notification = message;
				const initializationError = await waitForInitialization({
					method: notification.method,
					sessionId,
					requestParams: notification.params,
				});
				if (initializationError) return initializationError;
				const protocolError = mcpSessions.validateProtocolHeader(
					request,
					sessionId,
					undefined,
					notification.method,
				);
				if (protocolError) {
					logResponseError({
						method: notification.method,
						sessionId: protocolError.sessionId ?? sessionId,
						requestParams: notification.params,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						protocolError.sessionId ?? sessionId,
						protocolError.status,
					);
				}
				const routeResult = mcpSessions.routeNotification(
					notification,
					sessionId,
				);
				if (routeResult.payload) {
					logResponseError({
						method: notification.method,
						sessionId: routeResult.sessionId ?? sessionId,
						requestParams: notification.params,
						payload: routeResult.payload,
						status: routeResult.status,
					});
					logClientTraffic({
						sessionId: routeResult.sessionId ?? sessionId,
						method: notification.method,
						request: notification,
						response: routeResult.payload,
					});
					return createJsonResponse(
						routeResult.payload,
						routeResult.sessionId ?? sessionId,
						routeResult.status,
					);
				}
				if (
					notification.method === 'notifications/cancelled' &&
					cancelledParamsType.allows(notification.params) &&
					sessionId
				) {
					// Unknown, completed and malformed cancellations are ignored. Only
					// this validated session can address its own active request IDs.
					activeRequests
						.get(sessionId)
						?.get(notification.params.requestId)
						?.abort();
				}
				logger.info(
					buildInboundMessageLog(
						notification.method,
						sessionId,
						notification.params,
					),
				);
				logClientTraffic({
					sessionId: routeResult.sessionId ?? sessionId,
					method: notification.method,
					request: notification,
					response: null,
				});
				return createNotificationResponse(routeResult.sessionId ?? sessionId);
			}

			if (isIncomingJsonRpcResponse(message)) {
				const protocolError = mcpSessions.validateProtocolHeader(
					request,
					sessionId,
					undefined,
					'response',
				);
				if (protocolError) {
					logResponseError({
						method: 'response',
						sessionId: protocolError.sessionId ?? sessionId,
						requestParams: undefined,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						protocolError.sessionId ?? sessionId,
						protocolError.status,
					);
				}
				const routeResult = mcpSessions.routeResponse(sessionId);
				if (routeResult.payload) {
					logResponseError({
						method: 'response',
						sessionId: routeResult.sessionId ?? sessionId,
						requestParams: undefined,
						payload: routeResult.payload,
						status: routeResult.status,
					});
					logClientTraffic({
						sessionId: routeResult.sessionId ?? sessionId,
						method: 'response',
						request: message,
						response: routeResult.payload,
					});
					return createJsonResponse(
						routeResult.payload,
						routeResult.sessionId ?? sessionId,
						routeResult.status,
					);
				}
				logger.info(buildInboundMessageLog('response', sessionId));
				logClientTraffic({
					sessionId: routeResult.sessionId ?? sessionId,
					method: 'response',
					request: message,
					response: null,
				});
				return createNotificationResponse(routeResult.sessionId ?? sessionId);
			}

			const jsonRpcRequest = message;
			try {
				const initializationError = await waitForInitialization({
					method: jsonRpcRequest.method,
					sessionId,
					requestParams: jsonRpcRequest.params,
					id: jsonRpcRequest.id,
				});
				if (initializationError) return initializationError;
				const protocolError = mcpSessions.validateProtocolHeader(
					request,
					sessionId,
					jsonRpcRequest.id,
					jsonRpcRequest.method,
				);
				if (protocolError) {
					logResponseError({
						method: jsonRpcRequest.method,
						sessionId: protocolError.sessionId ?? sessionId,
						requestParams: jsonRpcRequest.params,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						protocolError.sessionId ?? sessionId,
						protocolError.status,
					);
				}
				// The session is authoritative even when the optional 2025 header is
				// absent. Error classification must use this client's negotiated era.
				const routeResult = await routeCancellableRequest(
					jsonRpcRequest,
					sessionId,
					mcpSessions.getProtocolVersion(sessionId),
				);
				if (!routeResult.payload) return createCancelledResponse();
				const logSessionId = routeResult.sessionId ?? sessionId;
				if (
					!routeResult.status &&
					!isJsonRpcErrorResponse(routeResult.payload)
				) {
					logger.info(
						buildInboundMessageLog(
							jsonRpcRequest.method,
							logSessionId,
							jsonRpcRequest.params,
						),
					);
				}
				const response = createJsonResponse(
					routeResult.payload as OutgoingJsonRpcResponse,
					routeResult.sessionId ?? sessionId,
					routeResult.status,
				);
				logResponseError({
					method: jsonRpcRequest.method,
					sessionId: logSessionId,
					requestParams: jsonRpcRequest.params,
					payload: routeResult.payload,
					status: routeResult.status,
				});
				logClientTraffic({
					sessionId: routeResult.sessionId ?? sessionId,
					method: jsonRpcRequest.method,
					request: jsonRpcRequest,
					response: routeResult.payload,
				});
				return response;
			} catch (err) {
				logger.error(
					`Handler error: ${buildLogFields(jsonRpcRequest.method, sessionId, jsonRpcRequest.params)}, message=${errorMessage(err)}`,
				);
				logClientTraffic({
					sessionId,
					method: jsonRpcRequest.method,
					request: jsonRpcRequest,
					response: {
						error: errorMessage(err),
					},
				});
				return createJsonResponse(
					{
						jsonrpc: '2.0',
						id: jsonRpcRequest.id,
						error: {
							code: -32603,
							message: 'Internal server error',
						},
					},
					undefined,
					500,
				);
			}
		},
		async DELETE(request: Request) {
			if (!isValidOrigin(request)) return createOriginForbiddenResponse();
			if (
				request.headers.get('MCP-Protocol-Version') === CURRENT_PROTOCOL_VERSION
			)
				return new Response(null, {
					status: 405,
					headers: {
						Allow: 'POST',
					},
				});
			const sessionId = parseSessionId(request);
			const closeResult = mcpSessions.close(sessionId);
			if (closeResult.status === 202) {
				return new Response(null, {
					status: 202,
				});
			}
			return new Response(closeResult.reason ?? 'Session close failed', {
				status: closeResult.status,
			});
		},
	};
};

export { createMcpHttpRoute };
