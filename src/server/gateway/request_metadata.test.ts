import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpUpstreamBackend } from '@/server/mcp_upstreams/connections';
import { createInputSchemaCompiler } from '@/server/mcp_upstreams/input_schema';
import { createMcpUpstreamOperations } from '@/server/mcp_upstreams/method_calls';
import { ProtocolClient } from '@/server/mcp_upstreams/protocol_client';
import { startFixtureBackend } from '@/server/mcp_upstreams/protocol_fixture';
import type {
	CallToolParams,
	McpUpstreamManager,
	McpUpstreamServer,
} from '@/server/mcp_upstreams/types';
import { addResourcePrefix } from '@/shared/mcp_namespaces';
import {
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	recordOf,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import packageJson from '../../../package.json' with { type: 'json' };
import { expect, mock, test } from 'bun:test';

for (const backendVersion of SUPPORTED_PROTOCOL_VERSIONS)
	for (const transport of ['http', 'stdio'] as const)
		test(`${backendVersion} ${transport}: dispatch preserves application metadata with independent client revisions`, async () => {
			const backend = startFixtureBackend(transport, backendVersion, {
				echoRequest: true,
			});
			const server: McpUpstreamServer = {
				serverName: 'backend',
				serverConfig: {
					...backend.config,
					enabled: true,
					timeout: 2000,
					trafficLimit: 1000,
				},
			};
			const client = new ProtocolClient(server, backendVersion);
			const inputSchema = {
				type: 'object' as const,
			};
			const compiled = createInputSchemaCompiler()(inputSchema);
			if ('issue' in compiled) throw new Error(compiled.issue.detail);
			const validate = mock(compiled.validate);
			const operations = createMcpUpstreamOperations({
				getEnabledTool: ({ toolName }) =>
					toolName === 'echo'
						? {
								tool: {
									name: 'echo',
									inputSchema: {
										type: 'object',
									},
								},
								inputValidator: {
									validate,
								},
							}
						: undefined,
				getBackend: () => ({
					...createMcpUpstreamBackend(server),
					client,
				}),
				waitForRateLimit: async () => undefined,
			});
			const manager = {
				...operations,
				listEnabledTools: () =>
					new Map([
						[
							'backend',
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
			const route = createMcpRequestRouter({
				handlers: createHandlers({
					mcpUpstreamManager: manager,
				}),
				requireSession: () => null,
				handleInitialize: async () => ({
					payload: null,
				}),
			});
			try {
				await client.connect();
				for (const clientVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const applicationMetadata = {
						'com.example/context': {
							locale: 'ja',
							flags: [false, 0, null],
							version: clientVersion,
						},
						'com.example/empty': '',
						'com.example/progressToken': 'vendor token',
						'io.modelcontextprotocol/customExtension': {
							value: 'opaque extension',
						},
						traceparent:
							'00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
						tracestate: 'vendor=value',
						baggage: 'locale=ja',
					};
					const metadata = Object.freeze({
						...applicationMetadata,
						[PROTOCOL_VERSION_META]: clientVersion,
						[CLIENT_INFO_META]: {
							name: 'public-client',
							version: '2',
						},
						[CLIENT_CAPABILITIES_META]: {
							sampling: {},
							elicitation: {},
						},
						[SERVER_INFO_META]: {
							name: 'unrelated-server',
							version: '1',
						},
						progressToken: 0,
						'io.modelcontextprotocol/logLevel': 'debug',
						'io.modelcontextprotocol/subscriptionId': 12,
						'io.modelcontextprotocol/related-task': {
							taskId: 'unrelated-task',
						},
					});
					for (const [method, fields] of [
						[
							'tools/call',
							{
								name: 'backend__echo',
								arguments: {
									text: 'hello',
								},
							},
						],
						[
							'prompts/get',
							{
								name: 'backend__greet',
								arguments: {
									locale: 'ja',
								},
							},
						],
						[
							'resources/read',
							{
								uri: addResourcePrefix({
									serverName: 'backend',
									uri: 'file:///example',
								}),
							},
						],
					] as const) {
						const response = await route(
							{
								jsonrpc: '2.0',
								id: 1,
								method,
								params: {
									...fields,
									_meta: metadata,
									...(clientVersion === '2025-11-25'
										? {
												task: {
													ttl: 60000,
												},
											}
										: {}),
								},
							},
							{
								protocolVersion: clientVersion,
							},
						);
						const result = recordOf(recordOf(response.payload)?.result);
						const received = recordOf(
							recordOf(result?._meta)?.['com.example/request'],
						);
						expect(received?._meta).toEqual(
							backendVersion === CURRENT_PROTOCOL_VERSION
								? {
										...applicationMetadata,
										[PROTOCOL_VERSION_META]: backendVersion,
										[CLIENT_INFO_META]: {
											name: 'aawa-mcpx',
											version: packageJson.version,
										},
										[CLIENT_CAPABILITIES_META]: {},
									}
								: applicationMetadata,
						);
						expect(received).not.toHaveProperty('task');
						expect(received).not.toHaveProperty('requestState');
						expect(metadata[CLIENT_INFO_META].name).toBe('public-client');
						expect(metadata.progressToken).toBe(0);
						// A subsequent call on the same connection has only its own context.
						const plain = await route(
							{
								jsonrpc: '2.0',
								id: 2,
								method,
								params: fields,
							},
							{
								protocolVersion: clientVersion,
							},
						);
						const plainResult = recordOf(recordOf(plain.payload)?.result);
						const plainMetadata = recordOf(
							recordOf(recordOf(plainResult?._meta)?.['com.example/request'])
								?._meta,
						);
						if (backendVersion !== CURRENT_PROTOCOL_VERSION)
							expect(plainMetadata).toBeUndefined();
						else
							expect(
								Object.keys(plainMetadata ?? {}).sort((left, right) =>
									left.localeCompare(right),
								),
							).toEqual(
								[
									PROTOCOL_VERSION_META,
									CLIENT_INFO_META,
									CLIENT_CAPABILITIES_META,
								].sort((left, right) => left.localeCompare(right)),
							);
					}
				}
				expect(validate).toHaveBeenCalledTimes(6);
			} finally {
				await client.close();
				backend.stop();
			}
		});

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`${version}: unsupported options and malformed legacy metadata never invoke the backend`, async () => {
		const callTool = mock(async (_params: CallToolParams) => ({
			content: [],
		}));
		const manager = {
			callTool,
			listEnabledTools: () => new Map(),
		} as unknown as McpUpstreamManager;
		const route = createMcpRequestRouter({
			handlers: createHandlers({
				mcpUpstreamManager: manager,
			}),
			requireSession: () => null,
			handleInitialize: async () => ({
				payload: null,
			}),
		});
		const send = (extra: Record<string, unknown>) =>
			route(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'backend__echo',
						arguments: {},
						...extra,
					},
				},
				{
					protocolVersion: version,
				},
			);
		const invalidOptions: Record<string, unknown>[] = [
			{
				requestState: null,
			},
			{
				inputResponses: [],
			},
		];
		if (version !== '2025-11-25')
			invalidOptions.push({
				task: {},
			});
		if (version !== CURRENT_PROTOCOL_VERSION)
			for (const _meta of [
				null,
				[],
				'invalid',
				{
					progressToken: false,
				},
				{
					progressToken: 1.5,
				},
				{
					'invalid/key/path': true,
				},
			])
				invalidOptions.push({
					_meta,
				});
		for (const extra of invalidOptions) {
			const response = await send(extra);
			expect(recordOf(recordOf(response.payload)?.error)?.code).toBe(-32602);
			expect(response.status).toBe(
				version === CURRENT_PROTOCOL_VERSION ? 400 : undefined,
			);
		}
		expect(callTool).not.toHaveBeenCalled();
		if (version === '2025-11-25') {
			// No task capability: November requires normal execution, even with a
			// task option. Its unrelated metadata must not be discarded with it.
			await send({
				task: {
					ttl: 60000,
				},
				_meta: {
					'com.example/context': 'preserved',
				},
			});
			expect(callTool).toHaveBeenCalledTimes(1);
			expect(callTool.mock.calls[0]?.[0]).toMatchObject({
				metadata: {
					'com.example/context': 'preserved',
				},
			});
		}
	});
