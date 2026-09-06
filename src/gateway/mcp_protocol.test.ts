import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import {
	CLIENT_CAPABILITIES_META,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, test } from 'bun:test';

const fixture = () => {
	let refreshes = 0;
	const refreshCatalogs = async (): Promise<void> => {
		refreshes++;
	};
	const sessions = createMcpSessionManager({
		protocolHeaderName: 'MCP-Protocol-Version',
		supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
	});
	const manager = {
		listEnabledTools: () =>
			new Map([
				[
					'backend',
					{
						tools: [
							{
								name: 'echo',
								inputSchema: {
									type: 'object',
								},
							},
						],
					},
				],
			]),
		callTool: async (params: { args: Record<string, unknown> }) => ({
			content: [
				{
					type: 'text',
					text: String(params.args.text),
				},
			],
		}),
	} as unknown as McpUpstreamManager;
	const routeRequest = createMcpRequestRouter({
		beforeRequest: refreshCatalogs,
		handlers: createHandlers({
			mcpUpstreamManager: manager,
		}),
		requireSession: sessions.requireSession,
		handleInitialize: sessions.handleInitialize,
	});
	const route = createMcpHttpRoute({
		refreshCatalogs,
		acceptsContentType: () => true,
		buildInboundMessageLog: () => '',
		buildLogFields: () => '',
		createJsonResponse: (body, session, status) =>
			Response.json(body, {
				status: status ?? 200,
				headers: session
					? {
							'Mcp-Session-Id': session,
						}
					: {},
			}),
		createMethodNotAllowedResponse: () =>
			new Response(null, {
				status: 405,
			}),
		createNotificationResponse: () =>
			new Response(null, {
				status: 202,
			}),
		createOriginForbiddenResponse: () =>
			new Response(null, {
				status: 403,
			}),
		isValidOrigin: () => true,
		logResponseError: () => undefined,
		mcpSessions: sessions,
		parseSessionId: (request) =>
			request.headers.get('Mcp-Session-Id') ?? undefined,
		routeRequest,
		trafficStore: {
			logClientTraffic: () => undefined,
		} as unknown as TrafficStore,
		waitForInitialization: async () => null,
	});
	return {
		route,
		sessions,
		manager,
		refreshCount: () => refreshes,
	};
};

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`public ${version}: lifecycle, list and call`, async () => {
		const { route, manager, refreshCount } = fixture();
		let session: string | null = null;
		const send = async (
			method: string,
			params: Record<string, unknown> = {},
		) => {
			const usesRequestMetadata = version === CURRENT_PROTOCOL_VERSION;
			const body = usesRequestMetadata
				? {
						...params,
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					}
				: params;
			const headers = usesRequestMetadata
				? protocolHeaders(method, body)
				: new Headers({
						'MCP-Protocol-Version': version,
					});
			if (session) headers.set('Mcp-Session-Id', session);
			return route.POST(
				new Request('http://localhost/mcp', {
					method: 'POST',
					headers,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method,
						params: body,
					}),
				}),
			);
		};
		if (version !== CURRENT_PROTOCOL_VERSION) {
			const initial = await send('initialize', {
				protocolVersion: version,
				clientInfo: {
					name: 'test',
					version: '1',
				},
				capabilities: {},
			});
			session = initial.headers.get('Mcp-Session-Id');
			expect(session).toBeTruthy();
			expect(recordOf((await initial.json()).result)?.protocolVersion).toBe(
				version,
			);
		}
		const list = await send('tools/list');
		expect(list.status).toBe(200);
		expect(refreshCount()).toBe(1);
		const result = recordOf((await list.json()).result);
		expect(result?.tools).toEqual([
			{
				name: 'backend__echo',
				description: '[backend]',
				inputSchema: {
					type: 'object',
				},
			},
		]);
		const call = await send('tools/call', {
			name: 'backend__echo',
			arguments: {
				text: 'works',
			},
		});
		expect((await call.json()).result.content).toEqual([
			{
				type: 'text',
				text: 'works',
			},
		]);
		if (version === CURRENT_PROTOCOL_VERSION) {
			expect(list.headers.has('Mcp-Session-Id')).toBe(false);
			expect(result).toMatchObject({
				resultType: 'complete',
				ttlMs: 0,
				cacheScope: 'private',
			});
			expect((await send('ping')).status).toBe(404);
		}
		manager.callTool = async () => {
			throw new BackendRpcError('Missing tool', -32601, {
				tool: 'echo',
			});
		};
		const failure = await send('tools/call', {
			name: 'backend__echo',
		});
		expect(failure.status).toBe(
			version === CURRENT_PROTOCOL_VERSION ? 404 : 200,
		);
		expect((await failure.json()).error).toEqual({
			code: -32601,
			message: 'Missing tool',
			data: {
				tool: 'echo',
			},
		});
	});

test('initialize proposals choose a supported alternative and enforce stored version', async () => {
	const { sessions } = fixture();
	for (const protocolVersion of [
		'2025-06-18',
		'2025-11-25',
	]) {
		for (const clientInfo of [
			undefined,
			{
				name: 'test',
			},
			{
				version: '1',
			},
		]) {
			const rejected = await sessions.handleInitialize(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion,
						clientInfo,
					},
				},
				undefined,
			);
			expect(rejected.status).toBe(400);
		}
	}
	const initial = await sessions.handleInitialize(
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				clientInfo: {
					name: 'test',
					version: '1',
				},
			},
		},
		undefined,
	);
	expect(
		initial.payload &&
			'result' in initial.payload &&
			initial.payload.result.protocolVersion,
	).toBe('2025-11-25');
	expect(
		sessions.validateProtocolHeader(
			new Request('http://localhost', {
				headers: {
					'MCP-Protocol-Version': '2025-06-18',
				},
			}),
			initial.sessionId,
			2,
			'tools/list',
		)?.status,
	).toBe(400);
	expect(
		sessions.validateProtocolHeader(
			new Request('http://localhost'),
			initial.sessionId,
			2,
			'tools/list',
		),
	).toBeNull();
});

test('2026-07-28 header failures, unsupported version, and irrelevant sessions', async () => {
	const { route } = fixture();
	const send = (version: string, methodHeader?: string) =>
		route.POST(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					'MCP-Protocol-Version': version,
					...(methodHeader
						? {
								'Mcp-Method': methodHeader,
							}
						: {}),
					'Mcp-Session-Id': 'irrelevant',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'server/discover',
					params: {
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					},
				}),
			}),
		);
	expect((await (await send(CURRENT_PROTOCOL_VERSION)).json()).error.code).toBe(
		-32020,
	);
	expect(
		(await (await send('2099-01-01', 'server/discover')).json()).error,
	).toMatchObject({
		code: -32022,
		data: {
			requested: '2099-01-01',
			supported: [
				...SUPPORTED_PROTOCOL_VERSIONS,
			],
		},
	});
	const response = await send(CURRENT_PROTOCOL_VERSION, 'server/discover');
	expect(response.headers.has('Mcp-Session-Id')).toBe(false);
	expect((await response.json()).result.supportedVersions).toEqual([
		...SUPPORTED_PROTOCOL_VERSIONS,
	]);
});
