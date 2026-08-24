import { type } from 'arktype';

import type { IncomingJsonRpcRequest, RouteResult } from '@/gateway/json_rpc';
import type { createHandlers } from '@/gateway/mcp_handlers';

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
) => Promise<RouteResult>) => {
	const { handlers, requireSession, handleInitialize } = params;

	return async (request, sessionId) => {
		const method: string = request.method;
		switch (method) {
			case 'initialize':
				return await handleInitialize(request, sessionId);
			case 'tools/list': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				const result = handlers.listTools();
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'prompts/list': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				const result = handlers.listPrompts();
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'resources/list': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				const result = handlers.listResources();
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'tools/call': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				if (!namedArgumentsParamsType.allows(request.params)) {
					return createInvalidParamsError(
						request.id,
						'Invalid tools/call params.',
					);
				}
				const callParams = namedArgumentsParamsType.assert(request.params);
				const result = await handlers.callTool({
					name: callParams.name,
					args: callParams.arguments ?? {},
				});
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'prompts/get': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				if (!namedArgumentsParamsType.allows(request.params)) {
					return createInvalidParamsError(
						request.id,
						'Invalid prompts/get params.',
					);
				}
				const promptParams = namedArgumentsParamsType.assert(request.params);
				const result = await handlers.getPrompt({
					name: promptParams.name,
					args: promptParams.arguments ?? {},
				});
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'resources/read': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				if (!resourceReadParamsType.allows(request.params)) {
					return createInvalidParamsError(
						request.id,
						'Invalid resources/read params.',
					);
				}
				const resourceParams = resourceReadParamsType.assert(request.params);
				const result = await handlers.readResource({
					uri: resourceParams.uri,
				});
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result,
					},
					sessionId,
				};
			}
			case 'resources/templates/list': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							resourceTemplates: [],
						},
					},
					sessionId,
				};
			}
			case 'resources/subscribe':
			case 'resources/unsubscribe': {
				const invalid = requireSession(sessionId, request.id, request.method);
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
			case 'completion/complete': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							completion: {
								values: [],
								hasMore: false,
							},
						},
					},
					sessionId,
				};
			}
			case 'logging/setLevel': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: {},
					},
					sessionId,
				};
			}
			case 'tasks/list': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							tasks: [],
						},
					},
					sessionId,
				};
			}
			case 'tasks/get':
			case 'tasks/result':
			case 'tasks/cancel': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32601,
							message: 'Tasks not supported',
						},
					},
					sessionId,
				};
			}
			case 'sampling/createMessage': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32601,
							message: 'Sampling not supported',
						},
					},
					sessionId,
				};
			}
			case 'elicitation/create': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32601,
							message: 'Elicitation not supported',
						},
					},
					sessionId,
				};
			}
			case 'ping': {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
				return {
					payload: {
						jsonrpc: '2.0',
						id: request.id,
						result: {},
					},
					sessionId,
				};
			}
			default: {
				const invalid = requireSession(sessionId, request.id, request.method);
				if (invalid) return invalid;
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
		}
	};
};

export {
	createMcpRequestRouter,
	namedArgumentsParamsType,
	resourceReadParamsType,
};
