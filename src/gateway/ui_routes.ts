import { type } from 'arktype';

import { setInterval as setIntervalAsync } from 'node:timers/promises';

import { parsePrefix } from '@/gateway/mcp_namespaces';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

const toggleToolBodyType = type({
	name: 'string',
	enabled: 'boolean',
	'[string]': 'unknown',
});

const toggleBackendBodyType = type({
	serverName: 'string',
	enabled: 'boolean',
	'[string]': 'unknown',
});

const callToolBodyType = type({
	serverName: 'string',
	toolName: 'string',
	'arguments?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

type CreateUiRoutesParams = {
	mcpUpstreamManager: McpUpstreamManager;
	buildOverview: () => unknown;
	shutdownSignal: AbortSignal;
	trafficStore: TrafficStore;
};

const parsePagination = (url: string) => {
	const search = new URL(url).searchParams;
	const limitRaw = Number(search.get('limit'));
	const offsetRaw = Number(search.get('offset'));
	const errorsOnlyRaw = search.get('errorsOnly');
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
	const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
	const errorsOnly =
		errorsOnlyRaw === '1' ||
		errorsOnlyRaw === 'true' ||
		errorsOnlyRaw === 'yes';
	return {
		limit,
		offset,
		errorsOnly,
		search,
	};
};

const createUiRoutes = (params: CreateUiRoutesParams) => {
	const { buildOverview, mcpUpstreamManager, shutdownSignal, trafficStore } =
		params;
	return {
		'/api/overview': {
			GET() {
				try {
					const overview = buildOverview();
					return Response.json(overview);
				} catch (err) {
					logger.error(`UI overview error: ${errorMessage(err)}`);
					return new Response('Internal Server Error', {
						status: 500,
					});
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
					return new Response('Bad Request', {
						status: 400,
					});
				}

				try {
					const parsed = parsePrefix(body.name);
					const enabledTools = await mcpUpstreamManager.toggleTool({
						serverName: parsed.serverName,
						toolName: parsed.originalName,
						enabled: body.enabled,
					});
					return Response.json({
						serverName: parsed.serverName,
						toolName: parsed.originalName,
						enabled: body.enabled,
						enabledTools,
					});
				} catch (err) {
					logger.error(`Toggle tool error: ${errorMessage(err)}`);
					return new Response('Internal Server Error', {
						status: 500,
					});
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
					return new Response('Bad Request', {
						status: 400,
					});
				}

				try {
					await mcpUpstreamManager.toggleBackend(body);
					return Response.json(body);
				} catch (err) {
					logger.error(`Toggle backend error: ${errorMessage(err)}`);
					return new Response('Internal Server Error', {
						status: 500,
					});
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
					return new Response('Bad Request', {
						status: 400,
					});
				}

				try {
					const result = await mcpUpstreamManager.callTool({
						serverName: body.serverName,
						toolName: body.toolName,
						args: body.arguments ?? {},
					});
					return Response.json({
						serverName: body.serverName,
						toolName: body.toolName,
						result,
					});
				} catch (err) {
					logger.error(`Tool test error: ${errorMessage(err)}`);
					return new Response('Internal Server Error', {
						status: 500,
					});
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
				try {
					const { limit, offset, errorsOnly } = parsePagination(request.url);
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
					return new Response('Internal Server Error', {
						status: 500,
					});
				}
			},
		},
		'/api/debug/client': {
			async GET(request: Request) {
				const { limit, offset, errorsOnly } = parsePagination(request.url);
				try {
					const client = trafficStore.getClientTraffic({
						limit,
						offset,
						errorsOnly,
					});
					return Response.json(client);
				} catch (err) {
					logger.error(`Debug client error: ${errorMessage(err)}`);
					return new Response('Internal Server Error', {
						status: 500,
					});
				}
			},
		},
		'/api/debug/backend': {
			async GET(request: Request) {
				const { limit, offset, errorsOnly, search } = parsePagination(
					request.url,
				);
				const backend = search.get('backend');
				const method = search.get('method') ?? undefined;
				if (!backend) {
					return new Response('Missing backend parameter', {
						status: 400,
					});
				}
				try {
					const data = trafficStore.getBackendTraffic({
						backend,
						method: method && method.trim() !== '' ? method : undefined,
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
					return new Response('Internal Server Error', {
						status: 500,
					});
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

export { createUiRoutes };
