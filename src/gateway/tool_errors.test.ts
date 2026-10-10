import { createRouteFixture } from '@/gateway/route_fixture';
import { createInputSchemaCompiler } from '@/mcp_upstreams/input_schema';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import {
	BackendTransportError,
	ProtocolClient,
} from '@/mcp_upstreams/protocol_client';
import { startFixtureBackend } from '@/mcp_upstreams/protocol_fixture';
import type {
	McpUpstreamManager,
	McpUpstreamServer,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import {
	CLIENT_CAPABILITIES_META,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, mock, spyOn, test } from 'bun:test';

for (const backendVersion of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of [
		'http',
		'stdio',
	] as const) {
		test(`${backendVersion} ${transport}: tool errors keep their classification for every client revision`, async () => {
			const backend = startFixtureBackend(transport, backendVersion, {
				// An upstream HTTP status belongs to that hop, not the public one.
				handle: (message, reply) =>
					reply && 'error' in reply && message.method === 'tools/call'
						? Response.json(reply, {
								status: 400,
							})
						: undefined,
			});
			const server: McpUpstreamServer = {
				serverName: 'fixture',
				serverConfig: {
					...backend.config,
					enabled: true,
					timeout: 2000,
					trafficLimit: 10000,
				},
			};
			const client = new ProtocolClient(server, backendVersion);
			const inputSchema = {
				type: 'object',
				properties: {
					count: {
						type: 'integer',
					},
				},
				required: [
					'count',
				],
			};
			const compiled = createInputSchemaCompiler()(inputSchema);
			if ('issue' in compiled) throw new Error(compiled.issue.detail);
			const validate = spyOn(compiled, 'validate');
			const invoke = spyOn(client, 'callTool');
			const log = spyOn(logger, 'error').mockImplementation(() => undefined);
			const rateLimit = mock(async () => undefined);
			const operations = createMcpUpstreamOperations({
				clients: new Map([
					[
						'fixture',
						client,
					],
				]),
				getServer: (name) =>
					name === 'missing'
						? undefined
						: {
								...server,
								serverConfig: {
									...server.serverConfig,
									enabled: name !== 'disabled',
								},
							},
				getEnabledTools: () => [
					'echo',
				],
				getInputValidator: () => compiled,
				getOutputSchema: () => undefined,
				onValidationError: () => undefined,
				waitForRateLimit: rateLimit,
			});
			const manager = {
				...operations,
				listEnabledTools: () =>
					new Map([
						[
							'fixture',
							{
								tools: [
									{
										name: 'echo',
										inputSchema,
									},
								],
							},
						],
					]),
			} as unknown as McpUpstreamManager;
			const { route } = createRouteFixture(manager);
			try {
				await client.connect();
				await client.listTools();
				for (const clientVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const modern = clientVersion === CURRENT_PROTOCOL_VERSION;
					let session: string | null = null;
					const send = async (
						method: string,
						params: Record<string, unknown>,
						omitVersion = false,
					) => {
						const body = modern
							? {
									...params,
									_meta: {
										[PROTOCOL_VERSION_META]: clientVersion,
										[CLIENT_CAPABILITIES_META]: {},
									},
								}
							: params;
						const headers = modern
							? protocolHeaders(method, body)
							: new Headers(
									omitVersion
										? {}
										: {
												'MCP-Protocol-Version': clientVersion,
											},
								);
						if (session) headers.set('Mcp-Session-Id', session);
						return route.POST(
							new Request('http://localhost/mcp', {
								method: 'POST',
								headers,
								body: JSON.stringify({
									jsonrpc: '2.0',
									id: 'call',
									method,
									params: body,
								}),
							}),
						);
					};
					if (!modern) {
						const initial = await send('initialize', {
							protocolVersion: clientVersion,
							clientInfo: {
								name: 'errors-test',
								version: '1',
							},
						});
						session = initial.headers.get('Mcp-Session-Id');
						expect(session).toBeTruthy();
					}
					const assertError = async (
						response: Response,
						code: number,
						status: number,
					) => {
						expect(response.status).toBe(status);
						const body = await response.json();
						expect(body).toMatchObject({
							jsonrpc: '2.0',
							id: 'call',
							error: {
								code,
							},
						});
						expect(body).not.toHaveProperty('result');
						return body.error;
					};
					const sent = invoke.mock.calls.length;
					const validated = validate.mock.calls.length;
					const limited = rateLimit.mock.calls.length;
					for (const name of [
						'',
						'echo',
						'fixture__',
						'__echo',
						'missing__echo',
						'disabled__echo',
						'fixture__off',
						'fixture__unknown',
					])
						await assertError(
							await send('tools/call', {
								name,
								arguments: {
									count: 1,
								},
							}),
							-32602,
							modern ? 400 : 200,
						);
					await assertError(
						await send('tools/call', {
							name: 'down__echo',
							arguments: {
								count: 1,
							},
						}),
						-32603,
						modern ? 500 : 200,
					);
					expect(invoke.mock.calls).toHaveLength(sent);
					expect(validate.mock.calls).toHaveLength(validated);
					expect(rateLimit.mock.calls).toHaveLength(limited);
					for (const omitVersion of modern
						? [
								false,
							]
						: [
								false,
								true,
							]) {
						const response = await send(
							'tools/call',
							{
								name: 'fixture__echo',
								arguments: {},
							},
							omitVersion,
						);
						if (clientVersion === '2025-06-18')
							await assertError(response, -32602, 200);
						else {
							expect(response.status).toBe(200);
							expect((await response.json()).result).toMatchObject({
								isError: true,
							});
						}
					}
					// Genuine execution errors remain successful RPC responses, including
					// their feedback and metadata; no success-output validation is added.
					const execution = {
						content: [
							{
								type: 'text',
								text: 'API rate limit exceeded',
							},
						],
						isError: true,
						_meta: {
							'com.example/retry': true,
						},
					};
					const executionResponse = await send('tools/call', {
						name: 'fixture__echo',
						arguments: {
							count: 1,
							fixtureMode: 'result',
							reply: execution,
						},
					});
					expect(executionResponse.status).toBe(200);
					const executionBody = await executionResponse.json();
					expect(executionBody.result).toMatchObject(execution);
					expect(executionBody.result.resultType).toBe(
						modern ? 'complete' : undefined,
					);
					for (const code of [
						-32602,
						-32603,
						-32601,
						-32002,
						-32042,
						-32023,
						-32000,
						-32020,
						-32021,
						-32022,
						42,
					]) {
						const expected = modern
							? code === -32002
								? -32602
								: [
											-32042,
											-32023,
											-32000,
										].includes(code)
									? -32603
									: code
							: [
										-32020,
										-32021,
										-32022,
									].includes(code) ||
									(code === -32042 && clientVersion === '2025-06-18')
								? -32603
								: code;
						const status = !modern
							? 200
							: expected === -32601
								? 404
								: expected === -32603
									? 500
									: expected === 42
										? 200
										: 400;
						const error = {
							code,
							message: `Backend error ${code}`,
							data: {
								detail: 'preserved',
								...(code === -32002
									? {
											uri: 'file:///missing',
										}
									: {}),
								...(code === -32021
									? {
											requiredCapabilities: {
												sampling: {},
											},
										}
									: {}),
								...(code === -32022
									? {
											requested: backendVersion,
											supported: [
												backendVersion,
											],
										}
									: {}),
								...(code === -32042
									? {
											elicitations: [
												{
													mode: 'url',
													elicitationId: 'fixture-id',
													url: 'https://example.invalid/connect',
													message: 'Authorization required',
												},
											],
										}
									: {}),
							},
						};
						const response = await send('tools/call', {
							name: 'fixture__echo',
							arguments: {
								count: 1,
								fixtureMode: 'envelope',
								reply: {
									error,
								},
							},
						});
						expect(await assertError(response, expected, status)).toEqual({
							...error,
							code: expected,
						});
					}
					await assertError(
						await send('tools/call', {
							name: 'fixture__echo',
							arguments: {
								count: 1,
								fixtureMode: 'result',
								reply: {
									content: [
										{
											type: 'text',
											text: 42,
										},
									],
								},
							},
						}),
						-32603,
						modern ? 500 : 200,
					);
					invoke.mockImplementationOnce(async () => {
						throw new BackendTransportError(new Error('Connection reset'));
					});
					const beforeTransport = invoke.mock.calls.length;
					await assertError(
						await send('tools/call', {
							name: 'fixture__echo',
							arguments: {
								count: 1,
							},
						}),
						-32603,
						modern ? 500 : 200,
					);
					expect(invoke.mock.calls).toHaveLength(beforeTransport + 1);
					const successful = await send('tools/call', {
						name: 'fixture__echo',
						arguments: {
							count: 1,
							text: 'still works',
						},
					});
					expect((await successful.json()).result).not.toHaveProperty(
						'isError',
					);
				}
			} finally {
				validate.mockRestore();
				invoke.mockRestore();
				log.mockRestore();
				await client.close();
				backend.stop();
			}
		});
	}
}

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`${version}: unexpected gateway and HTTP handler failures use internal error`, async () => {
		const manager = {
			callTool: async () => {
				throw new Error('Unexpected dispatcher error');
			},
		} as unknown as McpUpstreamManager;
		const { route, routeRequest } = createRouteFixture(manager);
		const log = spyOn(logger, 'error').mockImplementation(() => undefined);
		const modern = version === CURRENT_PROTOCOL_VERSION;
		const params = {
			name: 'fixture__echo',
			...(modern
				? {
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					}
				: {}),
		};
		let session: string | null = null;
		const post = (method: string, body: Record<string, unknown>) => {
			const headers = modern
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
		try {
			if (!modern)
				session = (
					await post('initialize', {
						protocolVersion: version,
						clientInfo: {
							name: 'crash-test',
							version: '1',
						},
					})
				).headers.get('Mcp-Session-Id');
			const dispatcherFailure = await post('tools/call', params);
			expect(dispatcherFailure.status).toBe(modern ? 500 : 200);
			expect((await dispatcherFailure.json()).error).toEqual({
				code: -32603,
				message: 'Internal server error',
			});
			routeRequest.mockImplementationOnce(async () => {
				throw new Error('Unexpected HTTP handler error');
			});
			const httpFailure = await post('tools/call', params);
			expect(httpFailure.status).toBe(500);
			expect((await httpFailure.json()).error).toEqual({
				code: -32603,
				message: 'Internal server error',
			});
		} finally {
			log.mockRestore();
		}
	});
