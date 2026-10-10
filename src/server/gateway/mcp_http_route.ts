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
	rpcError,
} from '@/server/gateway/json_rpc';
import type { RouteRequest } from '@/server/gateway/mcp_request_router';
import type { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { logger } from '@/server/logger';
import type { CatalogRequest } from '@/server/mcp_upstreams/types';
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
	toolHeaderParameters,
	validateToolHeaders,
} from '@/shared/mcp_protocol';

type ClientTrafficEntry = Parameters<TrafficStore['logClientTraffic']>[0] & {
	sessionId?: string;
};

type McpSessionManager = ReturnType<typeof createMcpSessionManager>;

// Methods that read the backend catalogs, so they wait for initialization and
// refresh stale lists first.
const CATALOG_METHODS = new Set([
	'tools/list',
	'tools/call',
	'prompts/list',
	'prompts/get',
	'resources/list',
	'resources/templates/list',
	'resources/read',
]);

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
	getToolSchema?: (name: string) => unknown;
	onRequestMetadata?: (
		metadata: Record<string, unknown>,
		client?: ClientInfo,
	) => void;
	refreshCatalogs?: (request: CatalogRequest) => Promise<void>;
};

const MCP_SESSION_HEADER = 'mcp-session-id';

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
	const body = rpcError(undefined, -32600, 'Invalid Origin header.');
	return createJsonResponse(body, undefined, 403);
};

const parseSessionId = (request: Request): string | undefined =>
	request.headers.get(MCP_SESSION_HEADER) || undefined;

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
		const fields = recordOf(params);
		if (method === 'tools/call' && typeof fields?.name === 'string')
			message += `, tool=${fields.name}`;
		if (method === 'prompts/get' && typeof fields?.name === 'string')
			message += `, prompt=${fields.name}`;
		if (method === 'resources/read' && typeof fields?.uri === 'string')
			message += `, resource=${fields.uri}`;
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
			const payload = rpcError(
				params.id,
				-32603,
				`Server initialization failed: ${errorMessage(err)}`,
			);
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

	// Legacy IDs are scoped to a session, and number/string IDs remain distinct.
	// Initialize cannot be cancelled. Modern HTTP has no shared session/ID scope:
	// only the signal of that request's own connection can cancel its work.
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
					payload: rpcError(
						message.id,
						-32600,
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
			if (version !== CURRENT_PROTOCOL_VERSION)
				await refreshCatalogs(message, signal);
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
				const payload = rpcError(
					undefined,
					-32600,
					'MCP HTTP POST requests must accept application/json and text/event-stream.',
				);
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
				const payload = rpcError(
					undefined,
					-32700,
					`Invalid JSON: ${errorMessage(err)}`,
				);
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
				const payload = rpcError(maybeId, -32600, 'Invalid JSON-RPC message');
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
			// IDs. Newer revisions carry request metadata and reach the explicit
			// version error; other unknown headers fail the 2025 header check.
			if (
				('method' in message && message.method === 'server/discover') ||
				(metadata && PROTOCOL_VERSION_META in metadata) ||
				versionHeader === CURRENT_PROTOCOL_VERSION
			) {
				const fail = (
					code: number,
					text: string,
					data?: Record<string, unknown>,
				): Response =>
					createJsonResponse(
						rpcError(message.id, code, text, data),
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
						supported: [...SUPPORTED_PROTOCOL_VERSIONS],
					});
				if (request.headers.get('Mcp-Method') !== message.method)
					return fail(-32020, 'Missing or mismatched Mcp-Method');
				const bodyParams = recordOf(message.params);
				if (
					['tools/call', 'prompts/get', 'resources/read'].includes(
						message.method,
					)
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
						return fail(-32603, 'Internal server error');
					}
				}
				// Header rules were compiled at catalog fetch. Compare values directly
				// without encoding the body and decoding it again on every request.
				if (message.method === 'tools/call') {
					const name = String(bodyParams?.name);
					const schema = params.getToolSchema?.(name);
					let rules: ReturnType<typeof toolHeaderParameters>;
					try {
						rules = toolHeaderParameters(schema);
					} catch {
						return fail(
							-32602,
							`Tool "${name}" has invalid HTTP header annotations`,
						);
					}
					try {
						const issue = validateToolHeaders(
							request.headers,
							bodyParams?.arguments,
							rules,
						);
						if (issue) return fail(-32020, issue);
					} catch {
						return fail(-32020, 'Invalid mirrored tool parameter');
					}
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
							[...request.headers].filter(([name]) =>
								name.startsWith('mcp-param-'),
							),
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
						rpcError(message.id, -32603, 'Internal server error'),
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
						sessionId: sessionId,
						requestParams: notification.params,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						sessionId,
						protocolError.status,
					);
				}
				const invalid = mcpSessions.requireSession(
					sessionId,
					undefined,
					notification.method,
				);
				if (invalid) {
					logResponseError({
						method: notification.method,
						sessionId,
						requestParams: notification.params,
						payload: invalid.payload,
						status: invalid.status,
					});
					logClientTraffic({
						sessionId,
						method: notification.method,
						request: notification,
						response: invalid.payload,
					});
					return createJsonResponse(
						invalid.payload as OutgoingJsonRpcResponse,
						sessionId,
						invalid.status,
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
				if (protocolError) {
					logResponseError({
						method: 'response',
						sessionId: sessionId,
						requestParams: undefined,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						sessionId,
						protocolError.status,
					);
				}
				const invalid = mcpSessions.requireSession(
					sessionId,
					undefined,
					'response',
				);
				if (invalid) {
					logResponseError({
						method: 'response',
						sessionId,
						requestParams: undefined,
						payload: invalid.payload,
						status: invalid.status,
					});
					logClientTraffic({
						sessionId,
						method: 'response',
						request: message,
						response: invalid.payload,
					});
					return createJsonResponse(
						invalid.payload as OutgoingJsonRpcResponse,
						sessionId,
						invalid.status,
					);
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
				if (protocolError) {
					logResponseError({
						method: jsonRpcRequest.method,
						sessionId: sessionId,
						requestParams: jsonRpcRequest.params,
						payload: protocolError.payload,
						status: protocolError.status,
					});
					return createJsonResponse(
						protocolError.payload as OutgoingJsonRpcResponse,
						sessionId,
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
					routeResult.payload as OutgoingJsonRpcResponse,
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
					rpcError(jsonRpcRequest.id, -32603, 'Internal server error'),
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
