import { type } from 'arktype';

import type { IncomingJsonRpcRequest, RouteResult } from '@/gateway/json_rpc';
import type { createHandlers } from '@/gateway/mcp_handlers';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import { withCancellation } from '@/shared/cancellation';
import { legacyRequestMetadataType } from '@/shared/mcp_metadata';
import {
	requiresOutputWrapper,
	wrapOutputSchema,
} from '@/shared/mcp_output_schema';
import {
	CACHEABLE_METHODS,
	CURRENT_PROTOCOL_VERSION,
	isProtocolVersion,
	recordOf,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import { jsonObjectType } from '@/shared/mcp_schemas';

const namedArgumentsParamsType = type({
	name: 'string',
	'arguments?': jsonObjectType,
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

const clientErrorCode = (code: number, protocolVersion?: string): number => {
	if (protocolVersion !== CURRENT_PROTOCOL_VERSION) {
		// These protocol errors have meanings only in the revisions defining them.
		if (
			(code >= -32022 && code <= -32020) ||
			(code === -32042 && protocolVersion !== '2025-11-25')
		)
			return -32603;
		return code;
	}
	// Modern MCP replaces resource-not-found and forbids retired/unassigned
	// reserved codes. Preserve diagnostic message/data while adapting the code.
	if (code === -32002) return -32602;
	if (code >= -32099 && code <= -32000 && !(code >= -32022 && code <= -32020))
		return -32603;
	return code;
};

const modernErrorStatus = (code: number): number | undefined => {
	if (code === -32601) return 404;
	if (code === -32603) return 500;
	if (
		code === -32700 ||
		code === -32600 ||
		code === -32602 ||
		(code >= -32022 && code <= -32020)
	)
		return 400;
	return undefined;
};

const createMcpRequestRouter = (
	params: CreateMcpRequestRouterParams,
): ((
	request: IncomingJsonRpcRequest,
	sessionId: string | undefined,
	protocolVersion?: string,
	mirroredHeaders?: Record<string, string>,
	signal?: AbortSignal,
) => Promise<RouteResult>) => {
	const { handlers, handleInitialize } = params;

	const route = async (
		request: IncomingJsonRpcRequest,
		sessionId: string | undefined,
		protocolVersion?: string,
		mirroredHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<RouteResult> => {
		signal?.throwIfAborted();
		const usesRequestMetadata = protocolVersion === CURRENT_PROTOCOL_VERSION;
		const requireSession: RequireSession = usesRequestMetadata
			? () => null
			: params.requireSession;
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
		const bodyParams = recordOf(request.params);
		if (
			!usesRequestMetadata &&
			bodyParams &&
			'_meta' in bodyParams &&
			!legacyRequestMetadataType.allows(bodyParams._meta)
		)
			return createInvalidParamsError(request.id, 'Malformed request metadata');
		// Continuations need an end-to-end interaction path, which is not yet
		// implemented. Do not silently turn a continuation into a fresh operation.
		if (
			bodyParams &&
			('requestState' in bodyParams || 'inputResponses' in bodyParams)
		)
			return createInvalidParamsError(
				request.id,
				'Interactive continuations are not supported',
			);
		if (bodyParams && 'task' in bodyParams && protocolVersion !== '2025-11-25')
			return createInvalidParamsError(
				request.id,
				'Task augmentation is not supported by this protocol revision',
			);
		// November 2025 requires peers without task capabilities to ignore task
		// augmentation and execute normally. Only supported fields are dispatched.
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
				return success(
					handlers.listTools(
						protocolVersion !== undefined && isProtocolVersion(protocolVersion)
							? protocolVersion
							: undefined,
					),
				);
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
				const callParams = request.params;
				const args = {
					name: callParams.name,
					args: callParams.arguments ?? {},
					metadata: recordOf(callParams._meta),
					mirroredHeaders,
					signal,
					clientProtocolVersion:
						protocolVersion !== undefined && isProtocolVersion(protocolVersion)
							? protocolVersion
							: undefined,
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
				const resourceParams = request.params;
				return success(
					await handlers.readResource({
						uri: resourceParams.uri,
						metadata: recordOf(resourceParams._meta),
						mirroredHeaders,
						signal,
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
	return async (
		request,
		sessionId,
		protocolVersion,
		mirroredHeaders,
		signal,
	) => {
		signal?.throwIfAborted();
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
			await withCancellation(
				params.beforeRequest?.() ?? Promise.resolve(),
				signal,
			);
		let result: RouteResult;
		try {
			result = await route(
				request,
				sessionId,
				protocolVersion,
				mirroredHeaders,
				signal,
			);
			signal?.throwIfAborted();
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
		if ('error' in result.payload) {
			const code = clientErrorCode(result.payload.error.code, protocolVersion);
			return {
				...result,
				// HTTP statuses describe this client's binding, not the backend's.
				// Keep 2025 RPC responses at their existing HTTP status; modern MCP
				// requires 404 for unknown methods and 400 for its metadata errors.
				status:
					protocolVersion === CURRENT_PROTOCOL_VERSION
						? (modernErrorStatus(code) ?? result.status)
						: result.status,
				payload: {
					...result.payload,
					error: {
						...result.payload.error,
						code,
					},
				},
			};
		}
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
				if (
					request.method === 'tools/list' &&
					Array.isArray(sessionResult.tools)
				) {
					sessionResult.tools = sessionResult.tools.map(
						(tool: Record<string, unknown>) =>
							tool.outputSchema === undefined
								? tool
								: {
										...tool,
										outputSchema: wrapOutputSchema(
											tool.outputSchema,
											String(tool.name),
										),
									},
					);
				}
				const structured = sessionResult.structuredContent;
				const outputSchema =
					request.method === 'tools/call'
						? handlers
								.listTools()
								.tools.find(
									(tool) => tool.name === recordOf(request.params)?.name,
								)?.outputSchema
						: undefined;
				// Both 2025 revisions require an object here; wrapping preserves scalar,
				// array, and null values returned by a 2026-07-28 backend.
				// Do not use truthiness: false, 0, an empty string, and null are real data.
				// Union schemas also wrap object values so every call matches the catalog
				// wrapper; object-only schemas and schema-free objects stay unchanged.
				if (
					structured !== undefined &&
					(requiresOutputWrapper(outputSchema) ||
						structured === null ||
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
