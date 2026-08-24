import {
	getJsonRpcId,
	getRecord,
	type IncomingJsonRpcRequest,
	isIncomingJsonRpcNotification,
	isIncomingJsonRpcResponse,
	type OutgoingJsonRpcResponse,
	parseIncomingJsonRpcMessage,
	type RouteResult,
} from '@/gateway/json_rpc';
import type { createMcpSessionManager } from '@/gateway/mcp_session';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

type McpSessionManager = ReturnType<typeof createMcpSessionManager>;

type RouteRequest = (
	request: IncomingJsonRpcRequest,
	sessionId: string | undefined,
) => Promise<RouteResult>;

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
	waitForInitialization: (params: {
		method: string;
		sessionId: string | undefined;
		requestParams?: unknown;
		id?: string | number;
	}) => Promise<Response | null>;
};

const isJsonRpcErrorResponse = (
	payload: OutgoingJsonRpcResponse | null,
): boolean => {
	return !!payload && 'error' in payload;
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
				const record = getRecord(rawBody);
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
					trafficStore.logClientTraffic({
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
				logger.info(
					buildInboundMessageLog(
						notification.method,
						sessionId,
						notification.params,
					),
				);
				trafficStore.logClientTraffic({
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
					trafficStore.logClientTraffic({
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
				trafficStore.logClientTraffic({
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
				const routeResult = await routeRequest(jsonRpcRequest, sessionId);
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
				trafficStore.logClientTraffic({
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
				trafficStore.logClientTraffic({
					sessionId,
					method: jsonRpcRequest.method,
					request: jsonRpcRequest,
					response: {
						error: errorMessage(err),
					},
				});
				return createJsonResponse({
					jsonrpc: '2.0',
					id: jsonRpcRequest.id,
					error: {
						code: -32000,
						message: 'Internal server error',
					},
				});
			}
		},
		async DELETE(request: Request) {
			if (!isValidOrigin(request)) return createOriginForbiddenResponse();
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
