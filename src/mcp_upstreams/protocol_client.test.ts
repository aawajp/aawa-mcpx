import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import { ProtocolClient } from '@/mcp_upstreams/protocol_client';
import { fixtureReply } from '@/mcp_upstreams/protocol_fixture';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import {
	CURRENT_PROTOCOL_VERSION,
	protocolHeaders,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, test } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of [
		'http',
		'stdio',
	] as const) {
		test(`${transport} backend ${version}: selection, core calls and pinned reconnect`, async () => {
			const methods: string[] = [];
			const server =
				transport === 'http'
					? Bun.serve({
							port: 0,
							hostname: '127.0.0.1',
							async fetch(request) {
								const message = recordOf(await request.json());
								if (!message)
									return new Response(null, {
										status: 400,
									});
								methods.push(String(message.method));
								if (!('id' in message))
									return new Response(null, {
										status: 202,
									});
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
								const reply = fixtureReply(message, version);
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
								return Response.json(reply);
							},
						})
					: undefined;
			const config =
				transport === 'http'
					? {
							type: 'http' as const,
							url: `http://127.0.0.1:${server?.port}/mcp`,
							enabled: true,
							timeout: 2000,
							trafficLimit: 1000,
						}
					: {
							type: 'stdio' as const,
							command: process.execPath,
							args: [
								new URL('./protocol_fixture.ts', import.meta.url).pathname,
								version,
							],
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
				server?.stop(true);
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
