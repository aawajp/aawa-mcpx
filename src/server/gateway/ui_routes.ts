import { type } from 'arktype';

import { setInterval as setIntervalAsync } from 'node:timers/promises';

import type { TrafficStore } from '@/server/db/traffic';
import { HOST_NOT_ALLOWED } from '@/server/gateway/allowed_hosts';
import { jsonError, readBody, readQuery } from '@/server/gateway/http';
import { logger } from '@/server/logger';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';
import { DASHBOARD_PATHS } from '@/shared/ui_api';

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

type CreateUiRoutesParams = {
	mcpUpstreamManager: McpUpstreamManager;
	buildOverview: () => unknown;
	shutdownSignal: AbortSignal;
	trafficStore: TrafficStore;
	// With a login, whether the request's session is still valid; an event
	// stream ends once it is not.
	isLoggedIn?: (request: Request) => boolean;
};

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

const createUiRoutes = (params: CreateUiRoutesParams) => {
	const {
		buildOverview,
		isLoggedIn,
		mcpUpstreamManager,
		shutdownSignal,
		trafficStore,
	} = params;
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
		[DASHBOARD_PATHS.overview]: {
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
		[DASHBOARD_PATHS.refreshBackends]: {
			async POST(request: Request) {
				const body = await readBody(refreshBackendsBodyType, request, (error) =>
					logger.warn(
						JSON.stringify({
							message: 'Invalid backend refresh request',
							error,
						}),
					),
				);
				if (body instanceof Response) return body;
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
		[DASHBOARD_PATHS.toggleTool]: {
			async POST(request: Request) {
				const body = await readBody(toggleToolBodyType, request, (error) =>
					logger.warn(`Invalid toggle tool request: ${error}`),
				);
				if (body instanceof Response) return body;
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
		[DASHBOARD_PATHS.toggleBackend]: {
			async POST(request: Request) {
				const body = await readBody(toggleBackendBodyType, request, (error) =>
					logger.warn(`Invalid toggle backend request: ${error}`),
				);
				if (body instanceof Response) return body;
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
		[DASHBOARD_PATHS.events]: {
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
								if (controllerState.closed || isLoggedIn?.(request) === false)
									break;
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
		[DASHBOARD_PATHS.debug]: {
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
		[DASHBOARD_PATHS.clientTraffic]: {
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
		[DASHBOARD_PATHS.backendTraffic]: {
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
		// For container health checks, without a login: it tells only that the
		// gateway serves, nothing about the backends.
		[DASHBOARD_PATHS.health]: {
			GET: () =>
				Response.json({
					status: 'ok',
				}),
		},
	};
};

export { createApiForbiddenResponse, createUiRoutes };
