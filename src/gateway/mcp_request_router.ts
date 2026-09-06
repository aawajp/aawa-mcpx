import { type } from 'arktype';

import type { IncomingJsonRpcRequest, RouteResult } from '@/gateway/json_rpc';
import type { createHandlers } from '@/gateway/mcp_handlers';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import {
	CACHEABLE_METHODS,
	CURRENT_PROTOCOL_VERSION,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

const namedArgumentsParamsType = type({
	name: 'string',
	'arguments?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const resourceReadParamsType = type({
	uri: 'string',
	'[string]': 'unknown',
});

type GatewayHandlers = ReturnType<typeof createHandlers>;

type RequireSession = (
	sessionId: string | undefined,
	id: string | number | undefined,
	method: string,
) => RouteResult | null;

type CreateMcpRequestRouterParams = {
	beforeRequest?: () => Promise<void>;
	handlers: GatewayHandlers;
	requireSession: RequireSession;
	handleInitialize: (
		request: IncomingJsonRpcRequest,
		incomingSessionId: string | undefined,
	) => Promise<RouteResult>;
};

const createInvalidParamsError = (
	id: string | number | undefined,
	message: string,
): RouteResult => {
	return {
		payload: {
			jsonrpc: '2.0',
			id,
			error: {
				code: -32602,
				message,
			},
		},
	};
};

const createMcpRequestRouter = (
	params: CreateMcpRequestRouterParams,
): ((
	request: IncomingJsonRpcRequest,
	sessionId: string | undefined,
	protocolVersion?: string,
) => Promise<RouteResult>) => {
	const { handlers, handleInitialize } = params;

	const route = async (
		request: IncomingJsonRpcRequest,
		sessionId: string | undefined,
		protocolVersion?: string,
	): Promise<RouteResult> => {
		const usesRequestMetadata = protocolVersion === CURRENT_PROTOCOL_VERSION;
		const requireSession: RequireSession = usesRequestMetadata
			? () => null
			: params.requireSession;
		if (usesRequestMetadata && request.method === 'server/discover')
			return {
				payload: {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						supportedVersions: [
							...SUPPORTED_PROTOCOL_VERSIONS,
						],
						capabilities: {
							tools: {},
							prompts: {},
							resources: {},
						},
					},
				},
			};
		if (
			(usesRequestMetadata &&
				[
					'initialize',
					'ping',
					'logging/setLevel',
					'completion/complete',
				].includes(request.method)) ||
			request.method.startsWith('tasks/')
		)
			return {
				status: usesRequestMetadata ? 404 : undefined,
				payload: {
					jsonrpc: '2.0',
					id: request.id,
					error: {
						code: -32601,
						message: 'Method not supported',
					},
				},
			};
		if (request.method === 'initialize')
			return await handleInitialize(request, sessionId);
		const invalid = requireSession(sessionId, request.id, request.method);
		if (invalid) return invalid;

		const success = (result: Record<string, unknown>): RouteResult => ({
			payload: {
				jsonrpc: '2.0',
				id: request.id,
				result,
			},
			sessionId,
		});
		const unsupported = (message: string): RouteResult => ({
			payload: {
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: -32601,
					message,
				},
			},
			sessionId,
		});
		switch (request.method) {
			case 'tools/list':
				return success(handlers.listTools());
			case 'prompts/list':
				return success(handlers.listPrompts());
			case 'resources/list':
				return success(handlers.listResources());
			case 'tools/call':
			case 'prompts/get': {
				if (!namedArgumentsParamsType.allows(request.params))
					return createInvalidParamsError(
						request.id,
						`Invalid ${request.method} params.`,
					);
				const callParams = namedArgumentsParamsType.assert(request.params);
				const args = {
					name: callParams.name,
					args: callParams.arguments ?? {},
				};
				return success(
					await (request.method === 'tools/call'
						? handlers.callTool(args)
						: handlers.getPrompt(args)),
				);
			}
			case 'resources/read': {
				if (!resourceReadParamsType.allows(request.params))
					return createInvalidParamsError(
						request.id,
						'Invalid resources/read params.',
					);
				const resourceParams = resourceReadParamsType.assert(request.params);
				return success(
					await handlers.readResource({
						uri: resourceParams.uri,
					}),
				);
			}
			case 'resources/templates/list':
				return success({
					resourceTemplates: [],
				});
			case 'resources/subscribe':
			case 'resources/unsubscribe':
				return unsupported('Resource subscriptions not supported');
			case 'completion/complete':
				return success({
					completion: {
						values: [],
						hasMore: false,
					},
				});
			case 'logging/setLevel':
			case 'ping':
				return success({});
			case 'sampling/createMessage':
				return unsupported('Sampling not supported');
			case 'elicitation/create':
				return unsupported('Elicitation not supported');
			default:
				return unsupported(`Method not found: ${request.method}`);
		}
	};
	return async (request, sessionId, protocolVersion) => {
		// The 2026-07-28 HTTP path already refreshes before mirrored-header
		// validation. Refreshing again here would fetch zero-TTL catalogs twice.
		if (
			protocolVersion !== CURRENT_PROTOCOL_VERSION &&
			[
				'tools/list',
				'tools/call',
				'prompts/list',
				'prompts/get',
				'resources/list',
				'resources/read',
			].includes(request.method)
		)
			await params.beforeRequest?.();
		let result: RouteResult;
		try {
			result = await route(request, sessionId, protocolVersion);
		} catch (error) {
			if (!(error instanceof BackendRpcError)) throw error;
			result = {
				payload: {
					jsonrpc: '2.0',
					id: request.id,
					error: {
						code: error.code,
						message: error.message,
						data: error.data,
					},
				},
				sessionId,
			};
		}
		if (!result.payload) return result;
		if (protocolVersion !== CURRENT_PROTOCOL_VERSION) {
			// The client and backend select versions independently. Strip the
			// 2026-07-28 result fields when replying with either supported 2025 revision.
			if ('result' in result.payload) {
				const sessionResult = {
					...result.payload.result,
				};
				delete sessionResult.resultType;
				delete sessionResult.ttlMs;
				delete sessionResult.cacheScope;
				const structured = sessionResult.structuredContent;
				// Both 2025 revisions require an object here; wrapping preserves scalar,
				// array, and null values returned by a 2026-07-28 backend.
				if (
					structured !== undefined &&
					(structured === null ||
						typeof structured !== 'object' ||
						Array.isArray(structured))
				)
					sessionResult.structuredContent = {
						value: structured,
					};
				return {
					...result,
					payload: {
						...result.payload,
						result: sessionResult,
					},
				};
			}
			return result;
		}
		if ('error' in result.payload)
			return {
				...result,
				status: result.payload.error.code === -32601 ? 404 : result.status,
			};
		return {
			...result,
			sessionId: undefined,
			// These are gateway cache hints, not a promise copied from one backend.
			payload: {
				...result.payload,
				result: {
					...result.payload.result,
					resultType: 'complete',
					_meta: {
						...result.payload.result._meta,
						[SERVER_INFO_META]: {
							name: 'aawa-mcpx',
							version: '1.0.0',
						},
					},
					...(CACHEABLE_METHODS.has(request.method)
						? {
								ttlMs: 0,
								cacheScope: 'private',
							}
						: {}),
				},
			},
		};
	};
};

export {
	createMcpRequestRouter,
	namedArgumentsParamsType,
	resourceReadParamsType,
};
