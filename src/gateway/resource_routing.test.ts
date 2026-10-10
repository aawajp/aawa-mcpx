import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createInputSchemaCompiler } from '@/mcp_upstreams/input_schema';
import { createMcpUpstreamOperations } from '@/mcp_upstreams/method_calls';
import { ProtocolClient } from '@/mcp_upstreams/protocol_client';
import { startFixtureBackend } from '@/mcp_upstreams/protocol_fixture';
import type {
	McpUpstreamManager,
	McpUpstreamServer,
} from '@/mcp_upstreams/types';
import { addPrefix, addResourcePrefix } from '@/shared/mcp_namespaces';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, mock, test } from 'bun:test';

for (const backendVersion of SUPPORTED_PROTOCOL_VERSIONS)
	for (const transport of [
		'http',
		'stdio',
	] as const) {
		test(`${backendVersion} ${transport}: namespaces route resources, tools, and prompts for every client revision`, async () => {
			const backend = startFixtureBackend(transport, backendVersion, {
				handle: (message, reply) => {
					const params = recordOf(message.params);
					if (message.method !== 'resources/read' || !reply) return undefined;
					if (params?.uri === 'file:///missing')
						return Response.json({
							jsonrpc: '2.0',
							id: message.id,
							error: {
								code:
									backendVersion === CURRENT_PROTOCOL_VERSION ? -32602 : -32002,
								message: 'Resource not found',
								data: {
									uri: params.uri,
								},
							},
						});
					const result = recordOf(reply.result);
					if (result)
						result.contents = [
							{
								uri: params?.uri,
								text: 'hello',
								_meta: {
									source: 'requested',
								},
							},
							{
								uri: 'urn:example:attachment',
								blob: 'aGk=',
								mimeType: 'text/plain',
							},
						];
					return undefined;
				},
			});
			const servers = new Map<string, McpUpstreamServer>();
			const clients = new Map<string, ProtocolClient>();
			for (const serverName of [
				'fixture',
				'fixture__extra',
				'fixture_',
			]) {
				const server: McpUpstreamServer = {
					serverName,
					serverConfig: {
						...backend.config,
						enabled: true,
						timeout: 2000,
						trafficLimit: 10000,
					},
				};
				servers.set(serverName, server);
				clients.set(serverName, new ProtocolClient(server, backendVersion));
			}
			const inputSchema = {
				type: 'object' as const,
			};
			const compiled = createInputSchemaCompiler()(inputSchema);
			const rateLimit = mock(async () => undefined);
			const operations = createMcpUpstreamOperations({
				clients,
				getEnabledTools: () => [
					'echo',
				],
				getInputValidator: () => compiled,
				getOutputSchema: () => undefined,
				getServer: (name) => {
					const existing = servers.get(name);
					if (existing) return existing;
					const base = servers.get('fixture');
					if (
						!base ||
						![
							'disabled',
							'down',
						].includes(name)
					)
						return undefined;
					return {
						...base,
						serverName: name,
						serverConfig: {
							...base.serverConfig,
							enabled: name !== 'disabled',
						},
					};
				},
				onValidationError: () => undefined,
				waitForRateLimit: rateLimit,
			});
			const manager = {
				...operations,
				listEnabledTools: () =>
					new Map(
						[
							...servers.keys(),
						].map((name) => [
							name,
							{
								tools: [
									{
										name: 'echo',
										inputSchema,
									},
								],
							},
						]),
					),
				listAllPrompts: () =>
					new Map(
						[
							...servers.keys(),
						].map((name) => [
							name,
							{
								prompts: [
									{
										name: 'greet',
									},
								],
							},
						]),
					),
				listAllResources: () =>
					new Map(
						[
							...servers.keys(),
						].map((name) => [
							name,
							{
								resources: [
									{
										name: 'example',
										uri: 'file:///example',
									},
								],
							},
						]),
					),
			} as unknown as McpUpstreamManager;
			const handlers = createHandlers({
				mcpUpstreamManager: manager,
			});
			const route = createMcpRequestRouter({
				handlers,
				requireSession: () => null,
				handleInitialize: async () => ({
					payload: null,
				}),
			});
			try {
				for (const client of clients.values()) await client.connect();
				for (const clientVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const send = (method: string, params: Record<string, unknown> = {}) =>
						route(
							{
								jsonrpc: '2.0',
								id: 1,
								method,
								params,
							},
							undefined,
							clientVersion,
						);
					const resultOf = async (
						method: string,
						params: Record<string, unknown> = {},
					) => {
						const response = await send(method, params);
						if (!response.payload || !('result' in response.payload))
							throw new Error(
								`Expected ${method} result: ${JSON.stringify(response.payload)}`,
							);
						return response.payload.result;
					};
					const tools = await resultOf('tools/list');
					expect(tools.tools).toEqual(
						expect.arrayContaining(
							[
								...servers.keys(),
							].map((serverName) =>
								expect.objectContaining({
									name: addPrefix({
										serverName,
										name: 'echo',
									}),
								}),
							),
						),
					);
					const prompts = await resultOf('prompts/list');
					expect(prompts.prompts).toEqual(
						expect.arrayContaining(
							[
								...servers.keys(),
							].map((serverName) =>
								expect.objectContaining({
									name: addPrefix({
										serverName,
										name: 'greet',
									}),
								}),
							),
						),
					);
					const resources = await resultOf('resources/list');
					expect(resources.resources).toEqual(
						expect.arrayContaining(
							[
								...servers.keys(),
							].map((serverName) =>
								expect.objectContaining({
									uri: addResourcePrefix({
										serverName,
										uri: 'file:///example',
									}),
								}),
							),
						),
					);
					for (const serverName of servers.keys()) {
						// Both identical catalog URIs and unlisted URIs must reach the correct
						// backend intact, including spelling that URL serialization changes.
						for (const uri of [
							'file:///example',
							'HTTPS://Example.COM/a/../b?q=https://other/#fragment',
							'urn:example:unlisted',
						]) {
							const wrapped = addResourcePrefix({
								serverName,
								uri,
							});
							const read = await resultOf('resources/read', {
								uri: wrapped,
							});
							expect(read.contents).toEqual(
								expect.arrayContaining([
									{
										uri: wrapped,
										text: 'hello',
										...(transport === 'http'
											? {
													_meta: {
														source: 'requested',
													},
												}
											: {}),
									},
								]),
							);
							if (transport === 'http')
								expect(read.contents).toEqual(
									expect.arrayContaining([
										{
											uri: addResourcePrefix({
												serverName,
												uri: 'urn:example:attachment',
											}),
											blob: 'aGk=',
											mimeType: 'text/plain',
										},
									]),
								);
						}
						const original = {
							content: [
								{
									type: 'resource_link',
									uri: 'urn:example:unlisted',
									name: 'linked',
									_meta: {
										marker: 1,
									},
								},
								{
									type: 'resource',
									resource: {
										uri: 'file:///embedded',
										text: 'hello',
										_meta: {
											marker: 2,
										},
									},
								},
								{
									type: 'text',
									text: 'file:///keep-this-text',
								},
							],
							structuredContent: {
								uri: 'file:///keep-this-data',
							},
							_meta: {
								marker: 3,
							},
						};
						const called = await resultOf('tools/call', {
							name: addPrefix({
								serverName,
								name: 'echo',
							}),
							arguments: {
								fixtureMode: 'result',
								reply: original,
							},
						});
						expect(called).toMatchObject({
							...original,
							content: [
								{
									...original.content[0],
									uri: addResourcePrefix({
										serverName,
										uri: 'urn:example:unlisted',
									}),
								},
								{
									type: 'resource',
									resource: {
										uri: addResourcePrefix({
											serverName,
											uri: 'file:///embedded',
										}),
										text: 'hello',
										_meta: {
											marker: 2,
										},
									},
								},
								original.content[2],
							],
						});
						expect(
							await resultOf('prompts/get', {
								name: addPrefix({
									serverName,
									name: 'greet',
								}),
							}),
						).toMatchObject({
							messages: [
								{
									role: 'user',
									content: {
										type: 'text',
										text: 'hello',
									},
								},
							],
						});
					}
					const legacy = await resultOf('resources/read', {
						uri: 'fixture://file:///example',
					});
					expect(legacy.contents).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								uri: addResourcePrefix({
									serverName: 'fixture',
									uri: 'file:///example',
								}),
							}),
						]),
					);
					const limited = rateLimit.mock.calls.length;
					for (const uri of [
						'file:///raw',
						'fixture://relative',
						'aawa-mcpx://resource/fixture/%ZZ',
						...[
							'missing',
							'disabled',
							'down',
						].map((serverName) =>
							addResourcePrefix({
								serverName,
								uri: 'file:///example',
							}),
						),
					]) {
						const expected = uri.includes('/down/') ? -32603 : -32602;
						const failed = await send('resources/read', {
							uri,
						});
						expect(failed.payload).toMatchObject({
							error: {
								code: expected,
							},
						});
					}
					for (const name of [
						'bad',
						'missing__greet',
						'disabled__greet',
						'down__greet',
					])
						expect(
							(
								await send('prompts/get', {
									name,
								})
							).payload,
						).toMatchObject({
							error: {
								code: name === 'down__greet' ? -32603 : -32602,
							},
						});
					expect(rateLimit.mock.calls).toHaveLength(limited);
					if (transport === 'http') {
						const failed = await send('resources/read', {
							uri: addResourcePrefix({
								serverName: 'fixture',
								uri: 'file:///missing',
							}),
						});
						expect(failed.payload).toMatchObject({
							error: {
								code:
									backendVersion === CURRENT_PROTOCOL_VERSION ||
									clientVersion === CURRENT_PROTOCOL_VERSION
										? -32602
										: -32002,
								data: {
									uri: 'file:///missing',
								},
							},
						});
					}
				}
			} finally {
				for (const client of clients.values()) await client.close();
				backend.stop();
			}
		});
	}

test('prompt embedded resources use the same namespace without changing message metadata', async () => {
	const manager = {
		getPrompt: async () => ({
			description: 'retained',
			_meta: {
				marker: 1,
			},
			messages: [
				{
					role: 'user',
					_meta: {
						marker: 2,
					},
					content: {
						type: 'resource',
						_meta: {
							marker: 3,
						},
						resource: {
							uri: 'file:///original%2fpath',
							blob: 'aGk=',
							mimeType: 'text/plain',
							_meta: {
								marker: 4,
							},
						},
					},
				},
			],
		}),
	} as unknown as McpUpstreamManager;
	const result = await createHandlers({
		mcpUpstreamManager: manager,
	}).getPrompt({
		name: addPrefix({
			serverName: 'a__b',
			name: 'prompt',
		}),
		args: {},
	});
	const expected = {
		description: 'retained',
		_meta: {
			marker: 1,
		},
		messages: [
			{
				role: 'user' as const,
				_meta: {
					marker: 2,
				},
				content: {
					type: 'resource' as const,
					_meta: {
						marker: 3,
					},
					resource: {
						uri: addResourcePrefix({
							serverName: 'a__b',
							uri: 'file:///original%2fpath',
						}),
						blob: 'aGk=',
						mimeType: 'text/plain',
						_meta: {
							marker: 4,
						},
					},
				},
			},
		],
	};
	expect(result).toEqual(expected);
});
