import { type } from 'arktype';

import { setInterval as setIntervalAsync } from 'node:timers/promises';

import { HOST_NOT_ALLOWED } from '@/server/gateway/allowed_hosts';
import { logger } from '@/server/logger';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { RPC_ERROR } from '@/shared/mcp_protocol';
import { jsonObjectType } from '@/shared/mcp_schemas';

const toggleToolBodyType = type({
	'+': 'reject',
	serverName: 'string',
	toolName: 'string',
	enabled: 'boolean',
});

const toggleBackendBodyType = type({
	'+': 'reject',
	serverName: 'string',
	enabled: 'boolean',
});

const refreshBackendsBodyType = type({
	'+': 'reject',
	'serverName?': 'string',
});

const callToolBodyType = type({
	'+': 'reject',
	serverName: 'string',
	toolName: 'string',
	'arguments?': jsonObjectType,
});

type CreateUiRoutesParams = {
	mcpUpstreamManager: McpUpstreamManager;
	buildOverview: () => unknown;
	shutdownSignal: AbortSignal;
	trafficStore: TrafficStore;
};

const jsonError = (status: number, message: string): Response =>
	Response.json(
		{
			error: message,
		},
		{
			status,
		},
	);

const createApiForbiddenResponse = (): Response =>
	jsonError(403, HOST_NOT_ALLOWED);

// Traffic bodies can be large, so a debug page holds at most this many records.
const PAGE_LIMIT = 100;

const pageFields = {
	'+': 'reject',
	limit: type('string.integer.parse')
		.to(`0 < number <= ${PAGE_LIMIT}`)
		.default('20'),
	offset: type('string.integer.parse').to('number >= 0').default('0'),
	errorsOnly: type("'0' | '1'")
		.pipe((value) => value === '1')
		.default('0'),
} as const;

const debugQueryType = type(pageFields);

const backendDebugQueryType = type({
	...pageFields,
	backend: 'string > 0',
	'method?': 'string > 0',
});

const readQuery = <T>(
	queryType: (value: unknown) => T | type.errors,
	url: string,
): T | Response => {
	const query = queryType(Object.fromEntries(new URL(url).searchParams));
	return query instanceof type.errors
		? jsonError(400, `Invalid query: ${query.summary}`)
		: query;
};

const createUiRoutes = (params: CreateUiRoutesParams) => {
	const { buildOverview, mcpUpstreamManager, shutdownSignal, trafficStore } =
		params;
	const findMissing = (
		serverName: string,
		toolName?: string,
	): Response | undefined => {
		const status = mcpUpstreamManager
			.getStatuses()
			.find((status) => status.serverName === serverName);
		if (!status) return jsonError(404, `Unknown MCP upstream "${serverName}"`);
		if (toolName !== undefined && !status.availableTools.includes(toolName))
			return jsonError(
				404,
				`Unknown tool "${toolName}" on MCP upstream "${serverName}"`,
			);
	};
	return {
		'/api/overview': {
			GET() {
				try {
					const overview = buildOverview();
					return Response.json(overview);
				} catch (err) {
					logger.error(`UI overview error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/backends/refresh': {
			async POST(request: Request) {
				let body: typeof refreshBackendsBodyType.infer;
				try {
					body = refreshBackendsBodyType.assert(await request.json());
				} catch (error) {
					logger.warn(
						JSON.stringify({
							message: 'Invalid backend refresh request',
							error: errorMessage(error),
						}),
					);
					return jsonError(400, `Invalid request body: ${errorMessage(error)}`);
				}
				const missing =
					body.serverName === undefined
						? undefined
						: findMissing(body.serverName);
				if (missing) return missing;
				try {
					await mcpUpstreamManager.refreshCatalogs(body);
					return Response.json(buildOverview());
				} catch (error) {
					logger.error(
						JSON.stringify({
							message: 'Backend refresh failed',
							context: {
								serverName: body.serverName,
							},
							error: errorMessage(error),
						}),
					);
					return jsonError(500, errorMessage(error));
				}
			},
		},
		'/api/tools/toggle': {
			async POST(request: Request) {
				let body: typeof toggleToolBodyType.infer;
				try {
					body = toggleToolBodyType.assert(await request.json());
				} catch (err) {
					logger.warn(`Invalid toggle tool request: ${errorMessage(err)}`);
					return jsonError(400, `Invalid request body: ${errorMessage(err)}`);
				}
				const missing = findMissing(body.serverName, body.toolName);
				if (missing) return missing;
				try {
					await mcpUpstreamManager.toggleTool({
						serverName: body.serverName,
						toolName: body.toolName,
						enabled: body.enabled,
					});
					return Response.json(buildOverview());
				} catch (err) {
					logger.error(`Toggle tool error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/backends/toggle': {
			async POST(request: Request) {
				let body: typeof toggleBackendBodyType.infer;
				try {
					body = toggleBackendBodyType.assert(await request.json());
				} catch (err) {
					logger.warn(`Invalid toggle backend request: ${errorMessage(err)}`);
					return jsonError(400, `Invalid request body: ${errorMessage(err)}`);
				}
				const missing = findMissing(body.serverName);
				if (missing) return missing;
				try {
					await mcpUpstreamManager.toggleBackend(body);
					return Response.json(buildOverview());
				} catch (err) {
					logger.error(`Toggle backend error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/tools/call': {
			async POST(request: Request) {
				let body: typeof callToolBodyType.infer;
				try {
					body = callToolBodyType.assert(await request.json());
				} catch (err) {
					logger.warn(`Invalid tool call request: ${errorMessage(err)}`);
					return jsonError(400, `Invalid request body: ${errorMessage(err)}`);
				}
				const missing = findMissing(body.serverName, body.toolName);
				if (missing) return missing;
				try {
					const result = await mcpUpstreamManager.callTool({
						tool: mcpUpstreamManager.getEnabledTool({
							serverName: body.serverName,
							toolName: body.toolName,
						}),
						args: body.arguments ?? {},
					});
					return Response.json({
						serverName: body.serverName,
						toolName: body.toolName,
						result,
					});
				} catch (err) {
					logger.error(`Tool test error: ${errorMessage(err)}`);
					return jsonError(
						err instanceof BackendRpcError &&
							err.code === RPC_ERROR.InvalidParams
							? 400
							: 500,
						errorMessage(err),
					);
				}
			},
		},
		'/api/events': {
			async GET(request: Request) {
				if (shutdownSignal.aborted) {
					return new Response(null, {
						status: 503,
					});
				}

				const encoder = new TextEncoder();
				const controllerState: {
					closed: boolean;
				} = {
					closed: false,
				};
				const streamAbortController = new AbortController();
				let closeStream: (() => void) | null = null;
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						let lastPayload = '';

						closeStream = () => {
							if (controllerState.closed) return;
							controllerState.closed = true;
							streamAbortController.abort();
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
						shutdownSignal.addEventListener('abort', handleAbort);
						if (request.signal.aborted || shutdownSignal.aborted) {
							closeStream();
						}

						const sendIfChanged = () => {
							if (controllerState.closed) return;
							const overview = buildOverview();
							if (controllerState.closed) return;
							const payload = JSON.stringify(overview);
							if (payload === lastPayload) return;
							try {
								controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
								lastPayload = payload;
							} catch (err) {
								closeStream?.();
								throw err;
							}
						};

						const sendHeartbeat = () => {
							if (controllerState.closed) return;
							try {
								controller.enqueue(encoder.encode(': heartbeat\n\n'));
							} catch (err) {
								closeStream?.();
								throw err;
							}
						};

						try {
							sendIfChanged();
							for await (const _ of setIntervalAsync(2000, undefined, {
								signal: streamAbortController.signal,
							})) {
								if (controllerState.closed) break;
								const previousPayload = lastPayload;
								sendIfChanged();
								if (lastPayload === previousPayload) {
									sendHeartbeat();
								}
							}
						} catch (err) {
							if ((err as Error).name !== 'AbortError') {
								logger.warn(
									`UI event stream send failed: ${errorMessage(err)}`,
								);
							}
						} finally {
							request.signal.removeEventListener('abort', handleAbort);
							shutdownSignal.removeEventListener('abort', handleAbort);
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
		'/api/debug': {
			async GET(request: Request) {
				const query = readQuery(debugQueryType, request.url);
				if (query instanceof Response) return query;
				const { limit, offset, errorsOnly } = query;
				try {
					const client = trafficStore.getClientTraffic({
						limit,
						offset,
						errorsOnly,
					});
					const statuses = mcpUpstreamManager.getStatuses();
					const backendResults = statuses
						.map((status) => status.serverName)
						.sort((a, b) => a.localeCompare(b))
						.map((backend) => ({
							backend,
							data: trafficStore.getBackendTraffic({
								backend,
								limit,
								offset,
								errorsOnly,
							}),
						}));

					return Response.json({
						client,
						backends: backendResults,
					});
				} catch (err) {
					logger.error(`Debug endpoint error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/debug/client': {
			async GET(request: Request) {
				const query = readQuery(debugQueryType, request.url);
				if (query instanceof Response) return query;
				const { limit, offset, errorsOnly } = query;
				try {
					const client = trafficStore.getClientTraffic({
						limit,
						offset,
						errorsOnly,
					});
					return Response.json(client);
				} catch (err) {
					logger.error(`Debug client error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/debug/backend': {
			async GET(request: Request) {
				const query = readQuery(backendDebugQueryType, request.url);
				if (query instanceof Response) return query;
				const { backend, method, limit, offset, errorsOnly } = query;
				try {
					const data = trafficStore.getBackendTraffic({
						backend,
						method,
						limit,
						offset,
						errorsOnly,
					});
					return Response.json({
						backend,
						method,
						errorsOnly,
						...data,
					});
				} catch (err) {
					logger.error(`Debug backend error: ${errorMessage(err)}`);
					return jsonError(500, errorMessage(err));
				}
			},
		},
		'/api/health': {
			async GET() {
				const backends = mcpUpstreamManager.getStatuses();
				const healthy = backends.every(
					(backend) => !backend.enabled || backend.connected,
				);
				return Response.json({
					status: healthy ? 'ok' : 'degraded',
					backends,
				});
			},
		},
	};
};

export { createApiForbiddenResponse, createUiRoutes };
