import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import {
	BackendRpcError,
	BackendTransportError,
	ProtocolClient,
	ProtocolNegotiationError,
} from '@/mcp_upstreams/protocol_client';
import {
	fixtureReply,
	startFixtureBackend,
} from '@/mcp_upstreams/protocol_fixture';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import {
	CLIENT_CAPABILITIES_META,
	CURRENT_PROTOCOL_VERSION,
	encodeHeaderValue,
	protocolHeaders,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, mock, spyOn, test } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	test(`HTTP backend ${version}: mirrors belong to the backend hop and refresh with the catalog`, async () => {
		const received: {
			message: Record<string, unknown>;
			headers: Headers;
		}[] = [];
		let headerName = 'Text';
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
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
			const tools = (await client.listTools()).tools;
			expect(tools.map((tool) => tool.name)).toEqual(
				version === CURRENT_PROTOCOL_VERSION
					? [
							'echo',
						]
					: [
							'echo',
							'bad',
						],
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
				undefined,
				{
					mirroredHeaders,
				},
			);
			await client.callTool(
				{
					name: 'echo',
					arguments: {
						text: null,
					},
				},
				undefined,
				{
					mirroredHeaders,
				},
			);
			headerName = 'Updated';
			await client.listTools();
			await client.callTool(
				{
					name: 'echo',
					arguments: {
						text: 'new',
					},
				},
				undefined,
				{
					mirroredHeaders: {
						'Mcp-Param-Updated': 'stale',
						'Mcp-Param-Opaque': 'forward me',
					},
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
				if (version !== CURRENT_PROTOCOL_VERSION) {
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
			if (version === CURRENT_PROTOCOL_VERSION) {
				const calls = received.filter(
					({ message }) => message.method === 'tools/call',
				);
				expect(calls[0]?.headers.get('Mcp-Param-Text')).toBe(
					encodeHeaderValue(' padded 世界 '),
				);
				expect(calls[0]?.headers.get('Mcp-Param-Count')).toBe('0');
				expect(calls[0]?.headers.get('Mcp-Param-Flag')).toBe('false');
				for (const name of [
					'Text',
					'Count',
					'Flag',
				])
					expect(calls[1]?.headers.has(`Mcp-Param-${name}`)).toBe(false);
				expect(calls[2]?.headers.get('Mcp-Param-Updated')).toBe('new');
				expect(calls[2]?.headers.has('Mcp-Param-Text')).toBe(false);
				expect(warning).toHaveBeenCalledTimes(2);
				expect(JSON.parse(warning.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
					context: {
						backend: 'headers',
						tool: 'bad',
						protocolVersion: version,
					},
				});
			} else expect(warning).not.toHaveBeenCalled();
			expect(onerror).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			await client.close();
			endpoint.stop(true);
		}
	});
}

test('a broken SSE response preserves the transport error and requests recovery', async () => {
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

test('caller cancellation does not invalidate a healthy connection', async () => {
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
				undefined,
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

test('a session lost between initialize and initialized remains retryable', async () => {
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
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
	for (const failure of [
		'timeout',
		'reset',
		'503',
	]) {
		test(`${method}: ${failure} remains retryable during the handshake`, async () => {
			const endpoint = Bun.serve({
				port: 0,
				hostname: '127.0.0.1',
				async fetch(request) {
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

// Legacy servers may reject discovery before initialization with id:null (or
// another uncorrelated ID). Strict envelope validation must not lose the HTTP
// rejection status and prevent negotiation with an otherwise supported peer.
for (const version of [
	'2025-11-25',
	'2025-06-18',
] as const) {
	for (const status of [
		400,
		404,
		405,
	]) {
		test(`initial discovery HTTP ${status} with an uncorrelated error falls back to ${version}`, async () => {
			for (const rejectedId of [
				null,
				undefined,
				'unrelated',
			]) {
				const methods: string[] = [];
				const endpoint = Bun.serve({
					port: 0,
					hostname: '127.0.0.1',
					async fetch(request) {
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
					serverName: 'legacy',
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

for (const status of [
	200,
	400,
	401,
	403,
	429,
	503,
]) {
	test(`uncorrelated HTTP ${status} discovery errors do not downgrade ${status === 400 ? 'a pinned modern peer' : 'without a legacy rejection'}`, async () => {
		const methods: string[] = [];
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
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
					? BackendTransportError
					: ProtocolNegotiationError,
			);
			expect(methods).toEqual([
				'server/discover',
			]);
		} finally {
			await client.close();
			endpoint.stop(true);
		}
	});
}

for (const code of [
	-32020,
	-32021,
	-32022,
]) {
	test(`valid modern discovery error ${code} never triggers initialization`, async () => {
		const methods: string[] = [];
		const endpoint = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(request) {
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
			serverName: 'modern',
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
			expect(methods).toEqual([
				'server/discover',
			]);
		} finally {
			await client.close();
			endpoint.stop(true);
		}
	});
}

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of [
		'http',
		'stdio',
	] as const) {
		test(`${transport} backend ${version}: selection, core calls and pinned reconnect`, async () => {
			const methods: string[] = [];
			const fixture = startFixtureBackend(transport, version, {
				handle: (message, reply, request) => {
					methods.push(String(message.method));
					if (!reply) return undefined;
					if (version === CURRENT_PROTOCOL_VERSION) {
						for (const [name, value] of protocolHeaders(
							String(message.method),
							recordOf(message.params) ?? {},
						))
							expect(request.headers.get(name)).toBe(value);
						if (message.method === 'tools/call')
							expect(request.headers.get('Mcp-Param-Text')).toBe(
								'=?base64?SGVsbG8sIOS4lueVjA==?=',
							);
					}
					if (
						message.method === 'server/discover' &&
						version !== CURRENT_PROTOCOL_VERSION
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
				expect((await client.listTools()).tools[0]?.name).toBe('echo');
				expect(
					(
						await client.callTool({
							name: 'echo',
							arguments: {
								text: 'Hello, 世界',
							},
						})
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
				const tools = await client.listTools();
				const sessions = createMcpSessionManager({
					protocolHeaderName: 'MCP-Protocol-Version',
					supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				});
				const manager = {
					listEnabledTools: () =>
						new Map([
							[
								'fixture',
								tools,
							],
						]),
					callTool: (params: {
						toolName: string;
						args: Record<string, unknown>;
					}) =>
						client.callTool({
							name: params.toolName,
							arguments: params.args,
						}),
				} as unknown as McpUpstreamManager;
				const route = createMcpRequestRouter({
					handlers: createHandlers({
						mcpUpstreamManager: manager,
					}),
					requireSession: sessions.requireSession,
					handleInitialize: sessions.handleInitialize,
				});
				for (const externalVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const initial =
						externalVersion === CURRENT_PROTOCOL_VERSION
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
						initial?.sessionId,
						externalVersion,
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
					const structuredValues: unknown[] =
						version === CURRENT_PROTOCOL_VERSION
							? [
									{
										count: 2,
									},
									{},
									[
										1,
										2,
									],
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
							initial?.sessionId,
							externalVersion,
						);
						const result =
							forwarded.payload && 'result' in forwarded.payload
								? forwarded.payload.result
								: undefined;
						expect(result?.structuredContent).toEqual(
							externalVersion === CURRENT_PROTOCOL_VERSION ||
								recordOf(structured)
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
				if (transport === 'http' && version !== CURRENT_PROTOCOL_VERSION)
					expect(methods).toEqual([
						'initialize',
						'notifications/initialized',
					]);
			} finally {
				await client.close();
				await reconnect?.close();
				fixture.stop();
			}
		});
	}
}

test('old-only backends are rejected before initialized', async () => {
	const methods: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
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
		expect(methods).toEqual([
			'server/discover',
			'initialize',
		]);
	} finally {
		await client.close();
		server.stop(true);
	}
});
