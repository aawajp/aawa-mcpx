import { type } from 'arktype';

import {
	type IncomingJsonRpcRequest,
	type RouteResult,
	rpcError,
} from '@/server/gateway/json_rpc';
import type { createHandlers } from '@/server/gateway/mcp_handlers';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import { sessionRequestMetadataType } from '@/shared/mcp_metadata';
import {
	requiresOutputWrapper,
	wrapOutputSchema,
} from '@/shared/mcp_output_schema';
import {
	CACHEABLE_METHODS,
	CURRENT_PROTOCOL_VERSION,
	GATEWAY_CAPABILITIES,
	GATEWAY_INFO,
	isProtocolVersion,
	JSONRPC_VERSION,
	MCP_ERROR_CODES,
	RPC_ERROR,
	recordOf,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
	validateToolHeaders,
} from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';
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
) => RouteResult | null;

type RouteOptions = {
	sessionId?: string;
	protocolVersion?: string;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type RouteRequest = (
	request: IncomingJsonRpcRequest,
	options?: RouteOptions,
) => Promise<RouteResult>;

type CreateMcpRequestRouterParams = {
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
		payload: rpcError(id, RPC_ERROR.InvalidParams, message),
	};
};

// Both 2025 revisions require an object here; wrapping preserves scalar, array,
// and null values returned by a 2026-07-28 backend. Do not use truthiness:
// false, 0, an empty string, and null are real data. Union schemas also wrap
// object values so every call matches the catalog wrapper; object-only schemas
// and schema-free objects stay unchanged.
const wrapStructuredContent = (
	result: ToolCallResult,
	outputSchema: unknown,
): ToolCallResult => {
	const structured = result.structuredContent;
	if (
		structured === undefined ||
		!(
			requiresOutputWrapper(outputSchema) ||
			structured === null ||
			typeof structured !== 'object' ||
			Array.isArray(structured)
		)
	)
		return result;
	return {
		...result,
		structuredContent: {
			value: structured,
		},
	};
};

const clientErrorCode = (code: number, protocolVersion?: string): number => {
	if (protocolVersion !== CURRENT_PROTOCOL_VERSION) {
		// These protocol errors have meanings only in the revisions defining them.
		if (
			MCP_ERROR_CODES.has(code) ||
			(code === RPC_ERROR.UrlElicitationRequired &&
				protocolVersion !== '2025-11-25')
		)
			return RPC_ERROR.InternalError;
		return code;
	}
	// MCP 2026-07-28 replaces resource-not-found and forbids retired/unassigned
	// reserved codes. Preserve diagnostic message/data while adapting the code.
	if (code === RPC_ERROR.ResourceNotFound) return RPC_ERROR.InvalidParams;
	if (code >= -32099 && code <= -32000 && !MCP_ERROR_CODES.has(code))
		return RPC_ERROR.InternalError;
	return code;
};

const errorHttpStatus = (code: number): number | undefined => {
	if (code === RPC_ERROR.MethodNotFound) return 404;
	if (code === RPC_ERROR.InternalError) return 500;
	if (
		code === RPC_ERROR.ParseError ||
		code === RPC_ERROR.InvalidRequest ||
		code === RPC_ERROR.InvalidParams ||
		MCP_ERROR_CODES.has(code)
	)
		return 400;
	return undefined;
};

const createMcpRequestRouter = (
	params: CreateMcpRequestRouterParams,
): RouteRequest => {
	const { handlers, handleInitialize } = params;

	const route = async (
		request: IncomingJsonRpcRequest,
		options: RouteOptions,
	): Promise<RouteResult> => {
		const { sessionId, protocolVersion, mirroredHeaders, signal } = options;
		signal?.throwIfAborted();
		const clientVersion =
			protocolVersion !== undefined && isProtocolVersion(protocolVersion)
				? protocolVersion
				: undefined;
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
				payload: rpcError(
					request.id,
					RPC_ERROR.MethodNotFound,
					'Method not supported',
				),
			};
		if (request.method === 'initialize')
			return await handleInitialize(request, sessionId);
		const invalid = requireSession(sessionId, request.id);
		if (invalid) return invalid;
		const bodyParams = recordOf(request.params);
		if (
			!usesRequestMetadata &&
			bodyParams &&
			'_meta' in bodyParams &&
			!sessionRequestMetadataType.allows(bodyParams._meta)
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
		const success = (result: Record<string, unknown>): RouteResult => ({
			payload: {
				jsonrpc: JSONRPC_VERSION,
				id: request.id,
				result,
			},
		});
		if (usesRequestMetadata && request.method === 'server/discover')
			return success({
				supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
				capabilities: GATEWAY_CAPABILITIES,
			});
		const unsupported = (message: string): RouteResult => ({
			payload: rpcError(request.id, RPC_ERROR.MethodNotFound, message),
		});
		switch (request.method) {
			case 'tools/list':
				return success(handlers.listTools(clientVersion));
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
				const args = callParams.arguments ?? {};
				const shared = {
					args,
					metadata: recordOf(callParams._meta),
					mirroredHeaders,
					signal,
				};
				if (request.method === 'prompts/get')
					return success(
						await handlers.getPrompt({
							...shared,
							name: callParams.name,
						}),
					);
				const tool = handlers.resolveTool(callParams.name);
				if (usesRequestMetadata) {
					// MCP 2026-07-28 mirrors annotated arguments in headers; they must match.
					if (tool.headerParameters instanceof Error)
						return createInvalidParamsError(
							request.id,
							`Tool "${callParams.name}" has invalid HTTP header annotations`,
						);
					let issue: string | undefined;
					try {
						issue = validateToolHeaders(
							new Headers(mirroredHeaders),
							args,
							tool.headerParameters,
						);
					} catch {
						issue = 'Invalid mirrored tool parameter';
					}
					if (issue)
						return {
							payload: rpcError(request.id, RPC_ERROR.HeaderMismatch, issue),
						};
				}
				const result = await handlers.callTool({
					...shared,
					tool,
					clientProtocolVersion: clientVersion,
				});
				return success(
					usesRequestMetadata
						? result
						: wrapStructuredContent(result, tool.tool.outputSchema),
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
				return success(handlers.listResourceTemplates());
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
			default:
				return unsupported(`Method not found: ${request.method}`);
		}
	};
	return async (request, options = {}) => {
		const { protocolVersion, signal } = options;
		let result: RouteResult;
		try {
			result = await route(request, options);
			signal?.throwIfAborted();
		} catch (error) {
			if (!(error instanceof BackendRpcError)) throw error;
			result = {
				payload: rpcError(request.id, error.code, error.message, error.data),
			};
		}
		if (!result.payload) return result;
		if ('error' in result.payload) {
			const code = clientErrorCode(result.payload.error.code, protocolVersion);
			return {
				...result,
				// HTTP statuses describe this client's binding, not the backend's.
				// Keep 2025 RPC responses at their existing HTTP status; MCP 2026-07-28
				// requires 404 for unknown methods and 400 for its metadata errors.
				status:
					protocolVersion === CURRENT_PROTOCOL_VERSION
						? (errorHttpStatus(code) ?? result.status)
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
			// These are gateway cache hints, not a promise copied from one backend.
			payload: {
				...result.payload,
				result: {
					...result.payload.result,
					resultType: 'complete',
					_meta: {
						...result.payload.result._meta,
						[SERVER_INFO_META]: GATEWAY_INFO,
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

export type { RouteRequest };
export { createMcpRequestRouter };
