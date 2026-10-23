import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { enabledTools, toolLookup } from '@/server/gateway/route_fixture';
import { logger } from '@/server/logger';
import {
	BackendRpcError,
	BackendTransportError,
	MESSAGE_SIZE_LIMIT,
	ProtocolClient,
	ProtocolNegotiationError,
} from '@/server/mcp_upstreams/protocol_client';
import {
	fixtureReply,
	startFixtureBackend,
} from '@/server/mcp_upstreams/protocol_fixture';
import type {
	CallToolParams,
	McpUpstreamManager,
} from '@/server/mcp_upstreams/types';
import {
	CLIENT_CAPABILITIES_META,
	CURRENT_PROTOCOL_VERSION,
	encodeHeaderValue,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
	toolHeaderParameters,
	usesRequestMetadata,
} from '@/shared/mcp_protocol';

import { expect, it, mock, spyOn } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	it(`HTTP backend ${version}: mirrors belong to the backend hop and refresh with the catalog`, async () => {
		const received: {
			message: Record<string, unknown>;
			headers: Headers;
		}[] = [];
		let headerName = 'Text';
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				received.push({
					message,
					headers: request.headers,
				});
				const reply = fixtureReply(message, version);
				if (message.method === 'tools/list') {
					const result = recordOf(reply.result);
					if (result)
						result.tools = [
							{
								name: 'echo',
								inputSchema: {
									type: 'object',
									properties: {
										text: {
											type: 'string',
											'x-mcp-header': headerName,
										},
										count: {
											type: 'integer',
											'x-mcp-header': 'Count',
										},
										flag: {
											type: 'boolean',
											'x-mcp-header': 'Flag',
										},
									},
								},
							},
							{
								name: 'bad',
								inputSchema: {
									type: 'object',
									properties: {
										value: {
											type: 'number',
											'x-mcp-header': 'Value',
										},
									},
								},
							},
						];
				}
				return Response.json(reply);
			},
		});
		const client = new ProtocolClient({
			serverName: 'headers',
			serverConfig: {
				type: 'http',
				url: endpoint.url.href,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
				headers: {
					'X-Fixture-Credential': 'retained',
					'Mcp-Method': 'stale',
					'Mcp-Name': 'public__echo',
					'Mcp-Param-Count': 'stale',
					'Mcp-Param-Flag': 'stale',
					'Mcp-Param-Static': 'stale',
				},
			},
		});
		client.protocolVersion = version;
		const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
		const onerror = mock(() => undefined);
		client.onerror = onerror;
		const mirroredHeaders = {
			'Mcp-Param-Text': 'client mirror',
			'Mcp-Param-Count': '42.0',
			'Mcp-Param-Flag': 'true',
			'Mcp-Param-Opaque': 'forward me',
		};
		try {
			let tools = (await client.listTools()).tools;
			expect(tools.map((tool) => tool.name)).toEqual(['echo', 'bad']);
			// The catalog compiles each tool's header rules; calls pass them in.
			const headerParameters = (name: string) =>
				toolHeaderParameters(
					tools.find((tool) => tool.name === name)?.inputSchema,
				);
			await client.callTool(
				{
					name: 'echo',
					arguments: {
						text: ' padded 世界 ',
						count: 0,
						flag: false,
					},
				},
				{
					mirroredHeaders,
					headerParameters: headerParameters('echo'),
				},
			);
			await client.callTool(
				{
					name: 'echo',
					arguments: {
						text: null,
					},
				},
				{
					mirroredHeaders,
					headerParameters: headerParameters('echo'),
				},
			);
			headerName = 'Updated';
			tools = (await client.listTools()).tools;
			await client.callTool(
				{
					name: 'echo',
					arguments: {
						text: 'new',
					},
				},
				{
					mirroredHeaders: {
						'Mcp-Param-Updated': 'stale',
						'Mcp-Param-Opaque': 'forward me',
					},
					headerParameters: headerParameters('echo'),
				},
			);
			await client.getPrompt(
				{
					name: 'greet',
				},
				{
					mirroredHeaders,
				},
			);
			await client.readResource(
				{
					uri: 'file:///example',
				},
				{
					mirroredHeaders,
				},
			);
			for (const { message, headers } of received) {
				expect(headers.get('X-Fixture-Credential')).toBe('retained');
				expect(headers.has('Mcp-Param-Static')).toBe(false);
				expect(headers.get('MCP-Protocol-Version')).toBe(version);
				if (!usesRequestMetadata(version)) {
					expect(
						Array.from(headers.keys()).some(
							(name) =>
								name === 'mcp-method' ||
								name === 'mcp-name' ||
								name.startsWith('mcp-param-'),
						),
					).toBe(false);
					continue;
				}
				expect(headers.get('Mcp-Method')).toBe(String(message.method));
				expect(
					recordOf(recordOf(message.params)?._meta)?.[CLIENT_CAPABILITIES_META],
				).toEqual({});
				if (message.method === 'tools/list') {
					expect(headers.has('Mcp-Name')).toBe(false);
					continue;
				}
				expect(headers.get('Mcp-Param-Opaque')).toBe('forward me');
				expect(headers.get('Mcp-Name')).toBe(
					message.method === 'resources/read'
						? 'file:///example'
						: message.method === 'prompts/get'
							? 'greet'
							: 'echo',
				);
			}
			if (usesRequestMetadata(version)) {
				const calls = received.filter(
					({ message }) => message.method === 'tools/call',
				);
				expect(calls[0]?.headers.get('Mcp-Param-Text')).toBe(
					encodeHeaderValue(' padded 世界 '),
				);
				expect(calls[0]?.headers.get('Mcp-Param-Count')).toBe('0');
				expect(calls[0]?.headers.get('Mcp-Param-Flag')).toBe('false');
				for (const name of ['Text', 'Count', 'Flag'])
					expect(calls[1]?.headers.has(`Mcp-Param-${name}`)).toBe(false);
				expect(calls[2]?.headers.get('Mcp-Param-Updated')).toBe('new');
				expect(calls[2]?.headers.has('Mcp-Param-Text')).toBe(false);
				await expect(
					client.callTool(
						{
							name: 'bad',
							arguments: {
								value: 1,
							},
						},
						{
							headerParameters: headerParameters('bad'),
						},
					),
				).rejects.toThrow('Invalid x-mcp-header annotation');
				expect(
					received.filter(({ message }) => message.method === 'tools/call'),
				).toHaveLength(3);
			}
			expect(warning).not.toHaveBeenCalled();
			expect(onerror).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			await client.close();
			endpoint.stop(true);
		}
	});
}

it('an SSE RPC error keeps the HTTP status of its response', async () => {
	const client = new ProtocolClient({
		serverName: 'stream',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
		_input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const { id } = JSON.parse(String(init?.body));
		return new Response(
			`data: ${JSON.stringify({
				jsonrpc: '2.0',
				id,
				error: {
					code: -32602,
					message: 'Invalid arguments',
				},
			})}\n\n`,
			{
				headers: {
					'Content-Type': 'text/event-stream',
				},
			},
		);
	}) as typeof globalThis.fetch);
	try {
		const error = await client
			.callTool({
				name: 'echo',
			})
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(BackendRpcError);
		expect(error).toMatchObject({
			code: -32602,
			status: 200,
		});
	} finally {
		fetch.mockRestore();
		await client.close();
	}
});

it('a broken SSE response preserves the transport error and requests recovery', async () => {
	const client = new ProtocolClient({
		serverName: 'stream',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	let recoveries = 0;
	client.ontransporterror = () => {
		recoveries += 1;
	};
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error('Socket reset while reading SSE'));
			},
		}),
		{
			headers: {
				'Content-Type': 'text/event-stream',
			},
		},
	);
	const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(response);
	try {
		await expect(
			client.callTool({
				name: 'echo',
			}),
		).rejects.toBeInstanceOf(BackendTransportError);
		expect(recoveries).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		fetch.mockRestore();
		await client.close();
	}
});

it('caller cancellation does not invalidate a healthy connection', async () => {
	const client = new ProtocolClient({
		serverName: 'cancelled',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	let recoveries = 0;
	client.ontransporterror = () => {
		recoveries += 1;
	};
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(
			client.callTool(
				{
					name: 'echo',
				},
				{
					signal: controller.signal,
				},
			),
		).rejects.toBeInstanceOf(BackendTransportError);
		expect(recoveries).toBe(0);
	} finally {
		await client.close();
	}
});

it('a session lost between initialize and initialized remains retryable', async () => {
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (request.method === 'DELETE')
				return new Response(null, {
					status: 405,
				});
			const message = recordOf(await request.json()) ?? {};
			if (message.method === 'notifications/initialized')
				return new Response('Session lost', {
					status: 404,
				});
			return Response.json(fixtureReply(message, '2025-11-25'), {
				headers: {
					'Mcp-Session-Id': 'lost',
				},
			});
		},
	});
	const client = new ProtocolClient(
		{
			serverName: 'lost',
			serverConfig: {
				type: 'http',
				url: endpoint.url.href,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
			},
		},
		'2025-11-25',
	);
	try {
		await expect(client.connect()).rejects.toBeInstanceOf(BackendRpcError);
	} finally {
		await client.close();
		endpoint.stop(true);
	}
});

for (const method of [
	'server/discover',
	'initialize',
	'notifications/initialized',
]) {
	for (const failure of ['timeout', 'reset', '503']) {
		it(`${method}: ${failure} remains retryable during the handshake`, async () => {
			const endpoint = Bun.serve({
				port: 0,
				hostname: '127.0.0.1',
				async fetch(request) {
					if (request.method === 'DELETE')
						return new Response(null, {
							status: 405,
						});
					const message = recordOf(await request.json()) ?? {};
					if (message.method === method) {
						if (failure === 'timeout')
							return new Promise<Response>(() => undefined);
						if (failure === 'reset') endpoint.stop(true);
						return new Response('Unavailable', {
							status: 503,
						});
					}
					if (!('id' in message))
						return new Response(null, {
							status: 202,
						});
					return Response.json(fixtureReply(message, '2025-11-25'));
				},
			});
			const client = new ProtocolClient(
				{
					serverName: 'handshake',
					serverConfig: {
						type: 'http',
						url: endpoint.url.href,
						enabled: true,
						timeout: 50,
						trafficLimit: 1000,
					},
				},
				method === 'server/discover' ? CURRENT_PROTOCOL_VERSION : '2025-11-25',
			);
			try {
				let caught: unknown;
				try {
					await client.connect();
				} catch (error) {
					caught = error;
				}
				expect(caught).not.toBeInstanceOf(ProtocolNegotiationError);
				expect(caught).toBeInstanceOf(
					failure === '503' ? BackendRpcError : BackendTransportError,
				);
			} finally {
				await client.close();
				endpoint.stop(true);
			}
		});
	}
}

// Servers without MCP 2026-07-28 may reject discovery before initialization
// with id:null (or another uncorrelated ID). Strict envelope validation must
// not lose the HTTP rejection status and prevent negotiation with an otherwise
// supported peer.
for (const version of ['2025-11-25', '2025-06-18'] as const) {
	for (const status of [400, 404, 405]) {
		it(`initial discovery HTTP ${status} with an uncorrelated error falls back to ${version}`, async () => {
			for (const rejectedId of [null, undefined, 'unrelated']) {
				const methods: string[] = [];
				const endpoint = Bun.serve({
					port: 0,
					hostname: '127.0.0.1',
					async fetch(request) {
						if (request.method === 'DELETE')
							return new Response(null, {
								status: 405,
							});
						const message = recordOf(await request.json()) ?? {};
						methods.push(String(message.method));
						if (message.method === 'server/discover')
							return Response.json(
								{
									jsonrpc: '2.0',
									id: rejectedId,
									error: {
										code: -32000,
										message: 'Not initialized',
										data: {
											discarded: true,
										},
									},
								},
								{
									status,
								},
							);
						if (!('id' in message))
							return new Response(null, {
								status: 202,
							});
						return Response.json(fixtureReply(message, version));
					},
				});
				const client = new ProtocolClient({
					serverName: 'session',
					serverConfig: {
						type: 'http',
						url: endpoint.url.href,
						enabled: true,
						timeout: 1000,
						trafficLimit: 1000,
					},
				});
				try {
					await client.connect();
					expect(client.protocolVersion).toBe(version);
					expect((await client.listTools()).tools[0]?.name).toBe('echo');
					expect(methods).toEqual([
						'server/discover',
						'initialize',
						'notifications/initialized',
						'tools/list',
					]);
				} finally {
					await client.close();
					endpoint.stop(true);
				}
			}
		});
	}
}

for (const status of [200, 400, 401, 403, 429, 503]) {
	it(`uncorrelated HTTP ${status} discovery errors do not downgrade ${status === 400 ? 'a pinned 2026-07-28 peer' : 'without a fallback rejection'}`, async () => {
		const methods: string[] = [];
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				methods.push(String(message.method));
				return Response.json(
					{
						jsonrpc: '2.0',
						id: null,
						error: {
							code: -32000,
							message: 'Rejected',
						},
					},
					{
						status,
					},
				);
			},
		});
		const client = new ProtocolClient(
			{
				serverName: 'no-downgrade',
				serverConfig: {
					type: 'http',
					url: endpoint.url.href,
					enabled: true,
					timeout: 1000,
					trafficLimit: 1000,
				},
			},
			status === 400 ? CURRENT_PROTOCOL_VERSION : undefined,
		);
		try {
			await expect(client.connect()).rejects.toBeInstanceOf(
				status === 429 || status === 503
					? BackendRpcError
					: ProtocolNegotiationError,
			);
			expect(methods).toEqual(['server/discover']);
		} finally {
			await client.close();
			endpoint.stop(true);
		}
	});
}

for (const code of [-32020, -32021, -32022]) {
	it(`valid 2026-07-28 discovery error ${code} never triggers initialization`, async () => {
		const methods: string[] = [];
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
				if (request.method === 'DELETE')
					return new Response(null, {
						status: 405,
					});
				const message = recordOf(await request.json()) ?? {};
				methods.push(String(message.method));
				return Response.json(
					{
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code,
							message: 'Protocol rejected',
						},
					},
					{
						status: 400,
					},
				);
			},
		});
		const client = new ProtocolClient({
			serverName: 'discovery',
			serverConfig: {
				type: 'http',
				url: endpoint.url.href,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
			},
		});
		try {
			await expect(client.connect()).rejects.toMatchObject({
				context: {
					httpStatus: 400,
					rpcCode: code,
				},
			});
			expect(methods).toEqual(['server/discover']);
		} finally {
			await client.close();
			endpoint.stop(true);
		}
	});
}

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of ['http', 'stdio'] as const) {
		it(`${transport} backend ${version}: selection, core calls and pinned reconnect`, async () => {
			const methods: string[] = [];
			const fixture = startFixtureBackend(transport, version, {
				handle: (message, reply, request) => {
					methods.push(String(message.method));
					if (!reply) return undefined;
					// Literal wire values, not derived from the sender's helper.
					if (usesRequestMetadata(version)) {
						expect(request.headers.get('MCP-Protocol-Version')).toBe(version);
						expect(request.headers.get('Mcp-Method')).toBe(
							String(message.method),
						);
						const name = {
							'tools/call': 'echo',
							'prompts/get': 'greet',
							'resources/read': 'file:///example',
						}[String(message.method)];
						expect(request.headers.get('Mcp-Name')).toBe(name ?? null);
						if (message.method === 'tools/call')
							expect(request.headers.get('Mcp-Param-Text')).toBe(
								'=?base64?SGVsbG8sIOS4lueVjA==?=',
							);
					}
					if (
						message.method === 'server/discover' &&
						!usesRequestMetadata(version)
					)
						return Response.json(
							version === '2025-06-18'
								? {
										jsonrpc: '2.0',
										id: message.id,
										error: {
											code: -32601,
											message: 'Method not found',
										},
									}
								: reply,
							{
								status: version === '2025-06-18' ? 200 : 400,
							},
						);
					if (message.method === 'tools/call')
						return new Response(
							`: keepalive\n\ndata: ${JSON.stringify({
								jsonrpc: '2.0',
								method: 'notifications/progress',
								params: {},
							})}\n\ndata: ${JSON.stringify(reply)}\n\n`,
							{
								headers: {
									'content-type': 'text/event-stream',
								},
							},
						);
					return undefined;
				},
			});
			const config = {
				...fixture.config,
				enabled: true,
				timeout: 2000,
				trafficLimit: 1000,
			};
			const backend = {
				serverName: 'fixture',
				serverConfig: config,
			};
			const client = new ProtocolClient(backend);
			let reconnect: ProtocolClient | undefined;
			try {
				await client.connect();
				expect(client.protocolVersion).toBe(version);
				const [echo] = (await client.listTools()).tools;
				expect(echo?.name).toBe('echo');
				expect(
					(
						await client.callTool(
							{
								name: 'echo',
								arguments: {
									text: 'Hello, 世界',
								},
							},
							{
								headerParameters: toolHeaderParameters(echo?.inputSchema),
							},
						)
					).content,
				).toEqual([
					{
						type: 'text',
						text: 'Hello, 世界',
					},
				]);
				expect((await client.listPrompts()).prompts[0]?.name).toBe('greet');
				expect(
					(
						await client.getPrompt({
							name: 'greet',
						})
					).messages,
				).toHaveLength(1);
				expect((await client.listResources()).resources).toHaveLength(1);
				expect(
					(
						await client.readResource({
							uri: 'file:///example',
						})
					).contents,
				).toHaveLength(1);
				await client.ping();
				const tools = enabledTools('fixture', (await client.listTools()).tools);
				const sessions = createMcpSessionManager({
					maxSessionsPerClient: 10,
					maxSessionsPerUser: 100,
				});
				const manager = {
					listEnabledTools: () => tools,
					getEnabledTool: toolLookup(tools),
					callTool: (params: CallToolParams) =>
						client.callTool(
							{
								name: params.tool.tool.name,
								arguments: params.args,
							},
							{
								headerParameters: params.tool.headerParameters,
							},
						),
				} as unknown as McpUpstreamManager;
				const route = createMcpRequestRouter({
					handlers: createHandlers({
						mcpUpstreamManager: manager,
					}),
					requireSession: sessions.requireSession,
					handleInitialize: sessions.handleInitialize,
				});
				// MCP 2026-07-28 public HTTP mirrors the annotated argument in a header.
				const mirroredHeaders = {
					'Mcp-Param-Text': encodeHeaderValue('Hello, 世界'),
				};
				for (const externalVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const initial = usesRequestMetadata(externalVersion)
						? undefined
						: await sessions.handleInitialize(
								{
									jsonrpc: '2.0',
									id: 1,
									method: 'initialize',
									params: {
										protocolVersion: externalVersion,
										clientInfo: {
											name: 'test',
											version: '1',
										},
									},
								},
								undefined,
							);
					const response = await route(
						{
							jsonrpc: '2.0',
							id: 2,
							method: 'tools/call',
							params: {
								name: 'fixture__echo',
								arguments: {
									text: 'Hello, 世界',
								},
							},
						},
						{
							sessionId: initial?.sessionId,
							protocolVersion: externalVersion,
							mirroredHeaders,
						},
					);
					expect(
						response.payload &&
							'result' in response.payload &&
							response.payload.result.content,
					).toEqual([
						{
							type: 'text',
							text: 'Hello, 世界',
						},
					]);
					expect(client.protocolVersion).toBe(version);
					const structuredValues: unknown[] = usesRequestMetadata(version)
						? [
								{
									count: 2,
								},
								{},
								[1, 2],
								[],
								'hello',
								'',
								3.5,
								0,
								true,
								false,
								null,
							]
						: [
								{
									count: 2,
								},
								{},
							];
					for (const structured of structuredValues) {
						const forwarded = await route(
							{
								jsonrpc: '2.0',
								id: 3,
								method: 'tools/call',
								params: {
									name: 'fixture__echo',
									arguments: {
										text: 'Hello, 世界',
										structured,
									},
								},
							},
							{
								sessionId: initial?.sessionId,
								protocolVersion: externalVersion,
								mirroredHeaders,
							},
						);
						const result =
							forwarded.payload && 'result' in forwarded.payload
								? forwarded.payload.result
								: undefined;
						expect(result?.structuredContent).toEqual(
							usesRequestMetadata(externalVersion) || recordOf(structured)
								? structured
								: {
										value: structured,
									},
						);
						expect(result?.content).toEqual([
							{
								type: 'text',
								text: 'Hello, 世界',
							},
						]);
					}
				}
				await client.close();
				methods.length = 0;
				reconnect = new ProtocolClient(backend, client.protocolVersion);
				await reconnect.connect();
				expect(reconnect.protocolVersion).toBe(version);
				if (transport === 'http' && !usesRequestMetadata(version))
					expect(methods).toEqual(['initialize', 'notifications/initialized']);
			} finally {
				await client.close();
				await reconnect?.close();
				fixture.stop();
			}
		});
	}
}

it('old-only backends are rejected before initialized', async () => {
	const methods: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === 'DELETE')
				return new Response(null, {
					status: 405,
				});
			const message = recordOf(await request.json()) ?? {};
			methods.push(String(message.method));
			return Response.json(fixtureReply(message, '2025-03-26'), {
				status: message.method === 'server/discover' ? 400 : 200,
			});
		},
	});
	const client = new ProtocolClient({
		serverName: 'old',
		serverConfig: {
			type: 'http',
			url: server.url.href,
			enabled: true,
			timeout: 1000,
			trafficLimit: 1,
		},
	});
	try {
		await expect(client.connect()).rejects.toThrow(
			'Unsupported backend protocol selection',
		);
		expect(methods).toEqual(['server/discover', 'initialize']);
	} finally {
		await client.close();
		server.stop(true);
	}
});

for (const version of ['2025-11-25', CURRENT_PROTOCOL_VERSION] as const)
	for (const transport of ['http', 'stdio'] as const)
		it(`${transport} backend ${version}: backend requests get answers and never complete gateway calls`, async () => {
			const answers: unknown[] = [];
			const answered = Promise.withResolvers<void>();
			const sessions: (string | null)[] = [];
			const fixture = startFixtureBackend(transport, version, {
				handle: (message, reply, request) => {
					if (!('method' in message)) {
						answers.push(message);
						sessions.push(request.headers.get('Mcp-Session-Id'));
						if (answers.length === 2) answered.resolve();
						return new Response(null, {
							status: 202,
						});
					}
					if (message.method === 'initialize' && reply)
						return Response.json(reply, {
							headers: {
								'Mcp-Session-Id': 'session-1',
							},
						});
					if (message.method !== 'tools/call' || !reply) return undefined;
					// The ping reuses the call's ID, which belongs to the gateway.
					const events = [
						{
							jsonrpc: '2.0',
							id: message.id,
							method: 'ping',
						},
						{
							jsonrpc: '2.0',
							id: 'reverse-1',
							method: 'sampling/createMessage',
						},
						reply,
					];
					return new Response(
						events
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(''),
						{
							headers: {
								'content-type': 'text/event-stream',
							},
						},
					);
				},
			});
			const client = new ProtocolClient({
				serverName: 'reverse',
				serverConfig: {
					...fixture.config,
					enabled: true,
					timeout: 2000,
					trafficLimit: 1000,
				},
			});
			const usesSession = !usesRequestMetadata(version);
			// The ping answer carries the call's ID, which differs per transport.
			const pingAnswer = usesSession
				? {
						jsonrpc: '2.0',
						result: {},
					}
				: {
						jsonrpc: '2.0',
						error: {
							code: -32601,
							message: 'Method not found',
						},
					};
			const expected = [
				expect.objectContaining(pingAnswer),
				{
					jsonrpc: '2.0',
					id: 'reverse-1',
					error: {
						code: -32601,
						message: 'Method not found',
					},
				},
			];
			try {
				await client.connect();
				const result = await client.callTool({
					name: 'echo',
					arguments: {
						text: 'done',
						fixtureMode: transport === 'stdio' ? 'reverse' : undefined,
					},
				});
				if (transport === 'stdio') {
					// The stdio fixture replies only after both answers arrive.
					const received = recordOf(result.structuredContent)?.answers;
					expect(received).toEqual(expected);
				} else if (usesSession) {
					expect(result.content).toEqual([
						{
							type: 'text',
							text: 'done',
						},
					]);
					await answered.promise;
					expect(answers).toEqual(expected);
					expect(sessions).toEqual(['session-1', 'session-1']);
				} else {
					// A 2026-07-28 HTTP hop has no channel for answers.
					expect(result.content).toEqual([
						{
							type: 'text',
							text: 'done',
						},
					]);
					expect(answers).toEqual([]);
				}
			} finally {
				await client.close();
				fixture.stop();
			}
		});

it('an unruly stdio backend keeps working, logs stderr and is killed on close', async () => {
	const info = spyOn(logger, 'info');
	const warn = spyOn(logger, 'warn');
	const fixture = startFixtureBackend('stdio', '2025-11-25', {
		unruly: true,
	});
	const client = new ProtocolClient({
		serverName: 'unruly',
		serverConfig: {
			...fixture.config,
			enabled: true,
			timeout: 2000,
			trafficLimit: 1000,
		},
	});
	try {
		await client.connect();
		expect(
			(
				await client.callTool({
					name: 'echo',
					arguments: {
						text: 'still works',
					},
				})
			).content,
		).toEqual([
			{
				type: 'text',
				text: 'still works',
			},
		]);
		expect(warn.mock.calls.flat()).toContain(
			'MCP upstream "unruly" wrote a non-JSON-RPC line to stdout',
		);
		const pid = Number(
			info.mock.calls
				.flat()
				.find((line) => line.startsWith('[unruly] pid='))
				?.slice('[unruly] pid='.length),
		);
		expect(pid).toBeGreaterThan(0);
		// The process ignores stdin EOF and SIGTERM, so close ends with SIGKILL.
		const started = Date.now();
		await client.close();
		expect(Date.now() - started).toBeLessThan(5000);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		info.mockRestore();
		warn.mockRestore();
		await client.close();
	}
});

it('fixture stdio backends never load env files', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mcpx-env-'));
	try {
		await writeFile(path.join(root, '.env'), 'SENTINEL_ENV=seen');
		await writeFile(path.join(root, '.env.local'), 'SENTINEL_LOCAL=seen');
		const probe = path.join(root, 'probe.ts');
		await writeFile(
			probe,
			'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith("SENTINEL")).sort()))',
		);
		const { command, args } = startFixtureBackend('stdio', '2025-11-25')
			.config as { command: string; args: string[] };
		// The fixture's Bun options, with the probe in place of the fixture.
		const options = args.slice(
			0,
			args.findIndex((arg) => arg.endsWith('protocol_fixture.ts')),
		);
		const run = async (bunOptions: string[]) => {
			const child = Bun.spawn([command, ...bunOptions, probe], {
				cwd: root,
				env: {
					PATH: process.env.PATH,
				},
			});
			return JSON.parse(await new Response(child.stdout).text());
		};
		// Without the options, Bun loads both files.
		expect(await run([])).toEqual(['SENTINEL_ENV', 'SENTINEL_LOCAL']);
		expect(await run(options)).toEqual([]);
	} finally {
		await rm(root, {
			recursive: true,
			force: true,
		});
	}
});

it('closing a 2025 HTTP backend ends its session with DELETE', async () => {
	const deletes: Headers[] = [];
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (request.method === 'DELETE') {
				deletes.push(request.headers);
				return new Response(null);
			}
			const message = recordOf(await request.json()) ?? {};
			if (!('id' in message))
				return new Response(null, {
					status: 202,
				});
			return Response.json(fixtureReply(message, '2025-11-25'), {
				headers: {
					'Mcp-Session-Id': 'session-1',
				},
			});
		},
	});
	const client = new ProtocolClient(
		{
			serverName: 'session',
			serverConfig: {
				type: 'http',
				url: endpoint.url.href,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
			},
		},
		'2025-11-25',
	);
	try {
		await client.connect();
		await client.close();
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.get('Mcp-Session-Id')).toBe('session-1');
		expect(deletes[0]?.get('MCP-Protocol-Version')).toBe('2025-11-25');
		await client.close();
		expect(deletes).toHaveLength(1);
	} finally {
		endpoint.stop(true);
	}
});

it('discovery without 2026-07-28 initializes with an offered 2025 revision', async () => {
	let offered = ['2025-06-18'];
	const fixture = startFixtureBackend('http', '2025-06-18', {
		handle: (message) =>
			message.method === 'server/discover'
				? Response.json({
						jsonrpc: '2.0',
						id: message.id,
						result: {
							supportedVersions: offered,
							capabilities: {},
							resultType: 'complete',
							ttlMs: 0,
							cacheScope: 'private',
						},
					})
				: undefined,
	});
	const connect = async (): Promise<ProtocolClient> => {
		const client = new ProtocolClient({
			serverName: 'offered',
			serverConfig: {
				...fixture.config,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
			},
		});
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	};
	try {
		const client = await connect();
		expect(client.protocolVersion).toBe('2025-06-18');
		await client.close();
		offered = ['2024-11-05'];
		await expect(connect()).rejects.toThrow(
			'Backend offers no supported protocol version: 2024-11-05',
		);
	} finally {
		fixture.stop();
	}
});

it('SSE responses accept CR, LF and CRLF line endings across chunks', async () => {
	const bodies = [
		// Bare CR endings, with the event split inside its JSON.
		(event: string) => [
			`data: ${event.slice(0, 10)}`,
			`${event.slice(10)}\r`,
			'\r',
		],
		// CRLF split between CR and LF, after a comment line.
		(event: string) => [': keepalive\r\ndata: ', `${event}\r`, '\n\r\n'],
	];
	let call = 0;
	const fixture = startFixtureBackend('http', CURRENT_PROTOCOL_VERSION, {
		handle: (message, reply) => {
			if (message.method !== 'tools/call' || !reply) return undefined;
			const chunks = bodies[call++]?.(JSON.stringify(reply)) ?? [];
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks)
							controller.enqueue(new TextEncoder().encode(chunk));
						controller.close();
					},
				}),
				{
					headers: {
						'content-type': 'text/event-stream',
					},
				},
			);
		},
	});
	const client = new ProtocolClient({
		serverName: 'sse',
		serverConfig: {
			...fixture.config,
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	try {
		await client.connect();
		await client.listTools();
		for (const text of ['cr', 'crlf'])
			expect(
				(
					await client.callTool({
						name: 'echo',
						arguments: {
							text,
						},
					})
				).content,
			).toEqual([
				{
					type: 'text',
					text,
				},
			]);
	} finally {
		await client.close();
		fixture.stop();
	}
});

// Pads a message with spaces to the given UTF-8 size; JSON ignores them.
const padded = (message: string, bytes: number): string =>
	message + ' '.repeat(bytes - Buffer.byteLength(message));
const encoder = new TextEncoder();
// Over the limit in bytes, but under it in UTF-16 units.
const wide = 'あ'.repeat(MESSAGE_SIZE_LIMIT / 4);

it('backend HTTP JSON bodies are limited in bytes and keep their HTTP status', async () => {
	const client = new ProtocolClient({
		serverName: 'large',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 5000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	const reply = (id: unknown, text: string) =>
		JSON.stringify({
			jsonrpc: '2.0',
			id,
			result: {
				resultType: 'complete',
				content: [
					{
						type: 'text',
						text,
					},
				],
			},
		});
	let cancelled = false;
	const cases: {
		status: number;
		body: (id: unknown) => BodyInit;
		headers?: Record<string, string>;
		text?: string;
	}[] = [
		{
			status: 200,
			body: (id) => padded(reply(id, 'ok'), MESSAGE_SIZE_LIMIT),
			text: 'ok',
		},
		{
			status: 200,
			body: (id) => padded(reply(id, wide), MESSAGE_SIZE_LIMIT),
			text: wide,
		},
		{
			status: 503,
			body: (id) => padded(reply(id, 'ok'), MESSAGE_SIZE_LIMIT + 1),
		},
		{
			status: 200,
			body: (id) => padded(reply(id, wide), MESSAGE_SIZE_LIMIT + 1),
		},
		// An endless body is cancelled once it passes the limit.
		{
			status: 200,
			body: () =>
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
					},
					cancel() {
						cancelled = true;
					},
				}),
		},
		// A Content-Length over the limit fails even before the body ends.
		{
			status: 502,
			body: (id) => reply(id, 'ok'),
			headers: {
				'Content-Length': String(MESSAGE_SIZE_LIMIT + 1),
			},
		},
	];
	let current = cases[0];
	const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
		_input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const { id } = JSON.parse(String(init?.body));
		return new Response(current?.body(id), {
			status: current?.status,
			headers: {
				'Content-Type': 'application/json',
				...current?.headers,
			},
		});
	}) as typeof globalThis.fetch);
	try {
		for (current of cases) {
			const result = client
				.callTool({
					name: 'echo',
				})
				.catch((error: unknown) => error);
			if (current.text)
				expect(await result).toMatchObject({
					content: [
						{
							type: 'text',
							text: current.text,
						},
					],
				});
			else {
				const error = await result;
				expect(error).toBeInstanceOf(BackendRpcError);
				expect(error).toMatchObject({
					message: 'Backend response exceeds size limit',
					status: current.status,
				});
			}
		}
		expect(cancelled).toBe(true);
	} finally {
		fetch.mockRestore();
		await client.close();
	}
});

it('backend stdio lines are limited in bytes wherever chunks split them', async () => {
	const client = new ProtocolClient({
		serverName: 'large',
		serverConfig: {
			type: 'stdio',
			command: 'unused',
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	});
	const { readLines } = client as unknown as {
		readLines(
			stream: ReadableStream<Uint8Array>,
			onLine: (line: string) => void,
			truncate: boolean,
		): Promise<void>;
	};
	const read = async (chunks: Uint8Array[]): Promise<string[]> => {
		const lines: string[] = [];
		await readLines.call(
			client,
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			(line) => lines.push(line),
			false,
		);
		return lines;
	};
	// Splits after the given byte, inside a character for the wide lines.
	const split = (line: string, at: number): Uint8Array[] => {
		const bytes = encoder.encode(line);
		return [bytes.subarray(0, at), bytes.subarray(at)];
	};
	const exact = 'a'.repeat(MESSAGE_SIZE_LIMIT);
	const wideExact = padded(wide, MESSAGE_SIZE_LIMIT).replaceAll(' ', 'a');
	expect(await read([encoder.encode(`${exact}\n{}\n`)])).toEqual([exact, '{}']);
	expect(await read(split(`${exact}\n`, 100))).toEqual([exact]);
	expect(await read(split(`${wideExact}\n`, 100))).toEqual([wideExact]);
	for (const chunks of [
		// The newline arrives in the same chunk as the line.
		[encoder.encode(`${exact}a\n`)],
		split(`${exact}a\n`, MESSAGE_SIZE_LIMIT),
		split(`${wideExact}a\n`, 100),
	])
		await expect(read(chunks)).rejects.toThrow(
			'Backend message exceeds size limit',
		);
});

it('backend SSE events are limited in bytes', async () => {
	const client = new ProtocolClient({
		serverName: 'large',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 5000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	// An event of the given size; the blank line ends it.
	const event = (message: unknown, bytes: number) =>
		`${padded(`data: ${JSON.stringify(message)}`, bytes - 2)}\n\n`;
	let body = (_id: unknown): string[] => [];
	const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
		_input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const { id } = JSON.parse(String(init?.body));
		return new Response(
			new ReadableStream({
				start(controller) {
					// Split inside the first event, inside a character for wide ones.
					const bytes = encoder.encode(body(id).join(''));
					controller.enqueue(bytes.subarray(0, 100));
					controller.enqueue(bytes.subarray(100));
					controller.close();
				},
			}),
			{
				headers: {
					'Content-Type': 'text/event-stream',
				},
			},
		);
	}) as typeof globalThis.fetch);
	const result = (id: unknown, text: string) => ({
		jsonrpc: '2.0',
		id,
		result: {
			resultType: 'complete',
			content: [
				{
					type: 'text',
					text,
				},
			],
		},
	});
	const progress = {
		jsonrpc: '2.0',
		method: 'notifications/message',
		params: {
			level: 'info',
			data: wide,
		},
	};
	try {
		// Each event has its own limit.
		for (const [text, events] of [
			[
				'ok',
				(id: unknown) => [
					event(progress, MESSAGE_SIZE_LIMIT),
					event(result(id, 'ok'), MESSAGE_SIZE_LIMIT),
				],
			],
			[wide, (id: unknown) => [event(result(id, wide), MESSAGE_SIZE_LIMIT)]],
		] as const) {
			body = events;
			expect(
				await client.callTool({
					name: 'echo',
				}),
			).toMatchObject({
				content: [
					{
						type: 'text',
						text,
					},
				],
			});
		}
		for (const events of [
			(id: unknown) => [event(result(id, 'ok'), MESSAGE_SIZE_LIMIT + 1)],
			(id: unknown) => [event(result(id, wide), MESSAGE_SIZE_LIMIT + 1)],
		]) {
			body = events;
			await expect(
				client.callTool({
					name: 'echo',
				}),
			).rejects.toThrow('Backend event exceeds size limit');
		}
	} finally {
		fetch.mockRestore();
		await client.close();
	}
});

it('a paginated backend list is limited to 32 MiB of items in all', async () => {
	const client = new ProtocolClient({
		serverName: 'paged',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/mcp',
			enabled: true,
			timeout: 5000,
			trafficLimit: 1000,
		},
	});
	client.protocolVersion = CURRENT_PROTOCOL_VERSION;
	// Each page is one tool with a 7 MiB description, under the message limit.
	const description = 'd'.repeat(7 * 1024 * 1024);
	let pages = 0;
	const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
		_input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const { id, params } = JSON.parse(String(init?.body));
		const page = params.cursor === undefined ? 0 : Number(params.cursor);
		return Response.json({
			jsonrpc: '2.0',
			id,
			result: {
				resultType: 'complete',
				ttlMs: 0,
				cacheScope: 'public',
				tools: [
					{
						name: `tool-${page}`,
						description,
						inputSchema: {
							type: 'object',
						},
					},
				],
				...(page + 1 < pages
					? {
							nextCursor: String(page + 1),
						}
					: {}),
			},
		});
	}) as typeof globalThis.fetch);
	try {
		pages = 4;
		expect((await client.listTools()).tools).toHaveLength(4);
		pages = 5;
		await expect(client.listTools()).rejects.toThrow(
			'Backend tools/list result exceeds 33554432 bytes',
		);
	} finally {
		fetch.mockRestore();
		await client.close();
	}
});
