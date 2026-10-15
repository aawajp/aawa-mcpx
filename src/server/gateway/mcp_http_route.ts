import { type } from 'arktype';

import { HOST_NOT_ALLOWED } from '@/server/gateway/allowed_hosts';
import {
	getJsonRpcId,
	type IncomingJsonRpcRequest,
	isIncomingJsonRpcNotification,
	isIncomingJsonRpcResponse,
	isJsonRpcErrorResponse,
	type OutgoingJsonRpcResponse,
	parseIncomingJsonRpcMessage,
	type RouteResult,
	rpcError,
} from '@/server/gateway/json_rpc';
import type { RouteRequest } from '@/server/gateway/mcp_request_router';
import type { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { logger } from '@/server/logger';
import type { CatalogRequest } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { withCancellation } from '@/shared/cancellation';
import {
	type ClientInfo,
	formatClientInfo,
	parseClientInfo,
} from '@/shared/client_info';
import { errorMessage } from '@/shared/common';
import { requestMetadataType } from '@/shared/mcp_metadata';
import {
	CATALOG_METHODS,
	CLIENT_INFO_META,
	decodeHeaderValue,
	MCP_HEADERS,
	NAMED_METHODS,
	PROTOCOL_VERSION_META,
	RPC_ERROR,
	recordOf,
	requestName,
	SUPPORTED_PROTOCOL_VERSIONS,
	usesRequestMetadata,
} from '@/shared/mcp_protocol';

type ClientTrafficEntry = Parameters<TrafficStore['logClientTraffic']>[0] & {
	sessionId?: string;
};

type McpSessionManager = ReturnType<typeof createMcpSessionManager>;

const NAME_LABELS: Record<string, string> = {
	'tools/call': 'tool',
	'prompts/get': 'prompt',
	'resources/read': 'resource',
};

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

type CreateMcpHttpRouteParams = {
	mcpSessions: McpSessionManager;
	routeRequest: RouteRequest;
	trafficStore: TrafficStore;
	// MCP requests wait for backend initialization and fail if it fails.
	initialization?: Promise<void>;
	onClientActivity?: (
		client: ClientInfo | undefined,
		protocolVersion: string,
	) => void;
	refreshCatalogs?: (request: CatalogRequest) => Promise<void>;
};

const createJsonResponse = (
	body: OutgoingJsonRpcResponse,
	sessionId?: string,
	status?: number,
): Response => {
	const headers = new Headers({
		'Content-Type': 'application/json',
	});
	if (sessionId) {
		headers.set(MCP_HEADERS.SessionId, sessionId);
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
		headers.set(MCP_HEADERS.SessionId, sessionId);
	}
	return new Response(null, {
		status: 202,
		headers,
	});
};

const createMcpForbiddenResponse = (): Response => {
	const body = rpcError(undefined, RPC_ERROR.InvalidRequest, HOST_NOT_ALLOWED);
	return createJsonResponse(body, undefined, 403);
};

const parseSessionId = (request: Request): string | undefined =>
	request.headers.get(MCP_HEADERS.SessionId) || undefined;

const getHeaderValues = (value: string | null): string[] => {
	if (!value) return [];
	return value
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item !== '');
};

const acceptsContentType = (request: Request, contentType: string): boolean => {
	const values = getHeaderValues(request.headers.get('accept'));
	return values.some((value) => {
		const [mediaType] = value.split(';');
		return mediaType === contentType || mediaType === '*/*';
	});
};

const createMcpHttpRoute = (params: CreateMcpHttpRouteParams) => {
	const {
		initialization = Promise.resolve(),
		mcpSessions,
		routeRequest,
		trafficStore,
	} = params;

	const buildLogFields = (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	): string => {
		let message = `client=${mcpSessions.formatClient(sessionId, params)}`;
		message += `, method=${method}`;
		// Log public identifiers directly. Routing validates/decodes them once;
		// logging runs at several points and must not repeat request validation.
		const name = requestName(method, recordOf(params));
		const label = NAME_LABELS[method];
		if (label && typeof name === 'string') message += `, ${label}=${name}`;
		return message;
	};

	const buildInboundMessageLog = (
		method: string,
		sessionId: string | undefined,
		params?: unknown,
	): string => {
		return `Message: ${buildLogFields(method, sessionId, params)}`;
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

	const respondError = (params: {
		method: string;
		sessionId: string | undefined;
		requestParams?: unknown;
		payload: OutgoingJsonRpcResponse;
		status: number;
	}): Response => {
		logResponseError(params);
		return createJsonResponse(params.payload, params.sessionId, params.status);
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
			return respondError({
				...params,
				payload: rpcError(
					params.id,
					RPC_ERROR.InternalError,
					`Server initialization failed: ${errorMessage(err)}`,
				),
				status: 503,
			});
		}
	};

	// Session request IDs are scoped to their session, and number/string IDs
	// remain distinct. Initialize cannot be cancelled. MCP 2026-07-28 HTTP has no
	// session or shared ID scope: only the request's own connection can cancel it.
	const activeRequests = new Map<
		string,
		Map<string | number, AbortController>
	>();
	const refreshCatalogs = async (
		message: IncomingJsonRpcRequest,
		signal?: AbortSignal,
	): Promise<void> => {
		if (!CATALOG_METHODS.has(message.method)) return;
		await withCancellation(
			Promise.resolve(
				params.refreshCatalogs?.({
					method: message.method,
					params: message.params,
				}),
			),
			signal,
		);
	};
	const routeCancellableRequest = async (
		message: IncomingJsonRpcRequest,
		sessionId: string | undefined,
		version?: string,
		mirrors?: Record<string, string>,
		disconnect?: AbortSignal,
	): Promise<RouteResult> => {
		const controller = new AbortController();
		const signal = usesRequestMetadata(version)
			? disconnect
			: controller.signal;
		const tracksId =
			sessionId !== undefined &&
			message.method !== 'initialize' &&
			!usesRequestMetadata(version);
		let requests =
			sessionId === undefined ? undefined : activeRequests.get(sessionId);
		if (tracksId) {
			if (requests?.has(message.id))
				return {
					payload: rpcError(
						message.id,
						RPC_ERROR.InvalidRequest,
						'Request ID is already in progress',
					),
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
			// The 2026-07-28 path refreshed before checking mirrored headers.
			if (!usesRequestMetadata(version)) await refreshCatalogs(message, signal);
			return await withCancellation(
				routeRequest(message, {
					sessionId,
					protocolVersion: version,
					mirroredHeaders: mirrors,
					signal: message.method === 'initialize' ? undefined : signal,
				}),
				signal,
			);
		} catch (error) {
			if (!signal?.aborted) throw error;
			// Cancellation has no JSON-RPC error code/result.
			return {
				payload: null,
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
		const client = usesRequestMetadata(entry.protocolVersion)
			? parseClientInfo(metadata?.[CLIENT_INFO_META])
			: mcpSessions.getClient(entry.sessionId);
		// Store the version now so subsequent session changes cannot rewrite history.
		trafficStore.logClientTraffic({
			client: client && formatClientInfo(client),
			method: entry.method,
			request: entry.request,
			response: entry.response,
			protocolVersion: getTrafficProtocolVersion(entry),
		});
	};

	return {
		async POST(request: Request) {
			const sessionId = parseSessionId(request);
			if (
				!acceptsContentType(request, 'application/json') ||
				!acceptsContentType(request, 'text/event-stream')
			) {
				return respondError({
					method: 'unknown',
					sessionId,
					payload: rpcError(
						undefined,
						RPC_ERROR.InvalidRequest,
						'MCP HTTP POST requests must accept application/json and text/event-stream.',
					),
					status: 400,
				});
			}
			let rawBody: unknown;
			try {
				rawBody = await request.json();
			} catch (err) {
				return respondError({
					method: 'unknown',
					sessionId,
					payload: rpcError(
						undefined,
						RPC_ERROR.ParseError,
						`Invalid JSON: ${errorMessage(err)}`,
					),
					status: 400,
				});
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
				return respondError({
					method,
					sessionId,
					requestParams: record?.params,
					payload: rpcError(
						maybeId,
						RPC_ERROR.InvalidRequest,
						'Invalid JSON-RPC message',
					),
					status: 400,
				});
			}

			const metadata = recordOf(recordOf(message.params)?._meta);
			const versionHeader = request.headers.get(MCP_HEADERS.ProtocolVersion);
			// Classify before session validation: MCP 2026-07-28 requests ignore
			// session IDs. Unsupported revisions that carry request metadata reach
			// the explicit version error; other unknown headers fail the session
			// version check.
			if (
				('method' in message && message.method === 'server/discover') ||
				(metadata && PROTOCOL_VERSION_META in metadata) ||
				usesRequestMetadata(versionHeader)
			) {
				const fail = (
					code: number,
					text: string,
					data?: Record<string, unknown>,
				): Response =>
					createJsonResponse(
						rpcError(message.id, code, text, data),
						undefined,
						code === RPC_ERROR.InternalError ? 500 : 400,
					);
				if (
					isIncomingJsonRpcNotification(message) ||
					isIncomingJsonRpcResponse(message)
				)
					return fail(
						RPC_ERROR.InvalidRequest,
						'MCP 2026-07-28 HTTP accepts requests only',
					);
				// Validate the request's own metadata before comparing mirrors. Missing
				// fields are InvalidParams, not a version/header negotiation failure.
				if (!requestMetadataType.allows(metadata))
					return fail(
						RPC_ERROR.InvalidParams,
						'Missing or malformed request metadata',
					);
				const version = metadata[PROTOCOL_VERSION_META];
				if (!versionHeader || versionHeader !== version)
					return fail(
						RPC_ERROR.HeaderMismatch,
						'Missing or mismatched protocol version header',
					);
				if (!usesRequestMetadata(version))
					return fail(
						RPC_ERROR.UnsupportedProtocolVersion,
						'Unsupported protocol version',
						{
							requested: version,
							supported: [...SUPPORTED_PROTOCOL_VERSIONS],
						},
					);
				if (request.headers.get(MCP_HEADERS.Method) !== message.method)
					return fail(
						RPC_ERROR.HeaderMismatch,
						'Missing or mismatched Mcp-Method',
					);
				const bodyParams = recordOf(message.params);
				if (NAMED_METHODS.has(message.method)) {
					const name = requestName(message.method, bodyParams);
					try {
						const header = request.headers.get(MCP_HEADERS.Name);
						if (header === null || decodeHeaderValue(header) !== name)
							return fail(
								RPC_ERROR.HeaderMismatch,
								'Missing or mismatched Mcp-Name',
							);
					} catch {
						return fail(RPC_ERROR.HeaderMismatch, 'Malformed Mcp-Name');
					}
				}
				if (CATALOG_METHODS.has(message.method)) {
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
						await refreshCatalogs(message, request.signal);
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
						return fail(RPC_ERROR.InternalError, 'Internal server error');
					}
				}
				// Metadata is already validated; activity tracking needs no second
				// parse/validation of client identity and grants it no capabilities.
				params.onClientActivity?.(metadata[CLIENT_INFO_META], version);
				try {
					const result = await routeCancellableRequest(
						message,
						undefined,
						version,
						// Unknown parameter mirrors remain opaque to this hop.
						Object.fromEntries(
							[...request.headers].filter(([name]) =>
								name.startsWith('mcp-param-'),
							),
						),
						request.signal,
					);
					if (!result.payload) return createCancelledResponse();
					logClientTraffic({
						protocolVersion: version,
						method: message.method,
						request: message,
						response: result.payload,
					});
					return createJsonResponse(result.payload, undefined, result.status);
				} catch {
					return createJsonResponse(
						rpcError(
							message.id,
							RPC_ERROR.InternalError,
							'Internal server error',
						),
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
				if (protocolError)
					return respondError({
						...protocolError,
						method: notification.method,
						sessionId,
						requestParams: notification.params,
					});
				const invalid = mcpSessions.requireSession(sessionId, undefined);
				if (invalid) {
					logClientTraffic({
						sessionId,
						method: notification.method,
						request: notification,
						response: invalid.payload,
					});
					return respondError({
						...invalid,
						method: notification.method,
						sessionId,
						requestParams: notification.params,
					});
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
					sessionId,
					method: notification.method,
					request: notification,
					response: null,
				});
				return createNotificationResponse(sessionId);
			}

			if (isIncomingJsonRpcResponse(message)) {
				const protocolError = mcpSessions.validateProtocolHeader(
					request,
					sessionId,
					undefined,
					'response',
				);
				if (protocolError)
					return respondError({
						...protocolError,
						method: 'response',
						sessionId,
					});
				const invalid = mcpSessions.requireSession(sessionId, undefined);
				if (invalid) {
					logClientTraffic({
						sessionId,
						method: 'response',
						request: message,
						response: invalid.payload,
					});
					return respondError({
						...invalid,
						method: 'response',
						sessionId,
					});
				}
				logger.info(buildInboundMessageLog('response', sessionId));
				logClientTraffic({
					sessionId,
					method: 'response',
					request: message,
					response: null,
				});
				return createNotificationResponse(sessionId);
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
				if (protocolError)
					return respondError({
						...protocolError,
						method: jsonRpcRequest.method,
						sessionId,
						requestParams: jsonRpcRequest.params,
					});
				// The session is authoritative even when the optional 2025 header is
				// absent. Error classification must use this client's negotiated era.
				const routeResult = await routeCancellableRequest(
					jsonRpcRequest,
					sessionId,
					mcpSessions.getProtocolVersion(sessionId),
				);
				if (!routeResult.payload) return createCancelledResponse();
				const responseSessionId = routeResult.sessionId ?? sessionId;
				if (
					!routeResult.status &&
					!isJsonRpcErrorResponse(routeResult.payload)
				) {
					logger.info(
						buildInboundMessageLog(
							jsonRpcRequest.method,
							responseSessionId,
							jsonRpcRequest.params,
						),
					);
				}
				const response = createJsonResponse(
					routeResult.payload,
					responseSessionId,
					routeResult.status,
				);
				logResponseError({
					method: jsonRpcRequest.method,
					sessionId: responseSessionId,
					requestParams: jsonRpcRequest.params,
					payload: routeResult.payload,
					status: routeResult.status,
				});
				logClientTraffic({
					sessionId: responseSessionId,
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
					rpcError(
						jsonRpcRequest.id,
						RPC_ERROR.InternalError,
						'Internal server error',
					),
					undefined,
					500,
				);
			}
		},
		async DELETE(request: Request) {
			if (usesRequestMetadata(request.headers.get(MCP_HEADERS.ProtocolVersion)))
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

export { createMcpForbiddenResponse, createMcpHttpRoute };
