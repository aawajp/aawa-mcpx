import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import {
	BackendRpcError,
	BackendTransportError,
	ProtocolClient,
} from '@/mcp_upstreams/protocol_client';
import { fixtureReply } from '@/mcp_upstreams/protocol_fixture';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { addResourcePrefix } from '@/shared/mcp_namespaces';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import {
	invalidToolResults,
	validToolContent,
} from '@/shared/mcp_schema_fixtures';

import { expect, test } from 'bun:test';

for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of [
		'json',
		'sse',
		'stdio',
	] as const) {
		test(`${version} ${transport}: validates envelopes and content without breaking client versions`, async () => {
			const server =
				transport === 'stdio'
					? undefined
					: Bun.serve({
							port: 0,
							hostname: '127.0.0.1',
							async fetch(request) {
								const message = recordOf(await request.json()) ?? {};
								if (!('id' in message))
									return new Response(null, {
										status: 202,
									});
								const reply = fixtureReply(message, version);
								if (transport === 'sse' && message.method === 'tools/call')
									return new Response(
										`data: ${JSON.stringify({
											jsonrpc: '2.0',
											method: 'notifications/progress',
											params: {},
										})}\n\ndata: ${JSON.stringify(reply)}\n\n`,
										{
											headers: {
												'Content-Type': 'text/event-stream',
											},
										},
									);
								return Response.json(reply);
							},
						});
			const client = new ProtocolClient(
				{
					serverName: 'fixture',
					serverConfig:
						transport === 'stdio'
							? {
									type: 'stdio',
									command: process.execPath,
									args: [
										new URL('./protocol_fixture.ts', import.meta.url).pathname,
										version,
									],
									enabled: true,
									timeout: 2000,
									trafficLimit: 1000,
								}
							: {
									type: 'http',
									url: server?.url.href ?? '',
									enabled: true,
									timeout: 2000,
									trafficLimit: 1000,
								},
				},
				version,
			);
			try {
				await client.connect();
				const callResult = (reply: Record<string, unknown>) =>
					client.callTool({
						name: 'echo',
						arguments: {
							fixtureMode: 'result',
							reply,
						},
					});
				const validResult = {
					content: validToolContent,
					structuredContent: {
						count: 2,
					},
					_meta: {
						'com.example/trace': 'kept',
					},
					'com.example/extension': {
						kept: true,
					},
				};
				expect(await callResult(validResult)).toMatchObject(validResult);
				expect(
					await callResult({
						content: [],
						isError: true,
					}),
				).toMatchObject({
					content: [],
					isError: true,
				});
				for (const reply of invalidToolResults)
					await expect(callResult(recordOf(reply) ?? {})).rejects.toThrow();
				for (const structuredContent of [
					[],
					'',
					0,
					false,
					null,
				]) {
					const result = {
						content: [],
						structuredContent,
					};
					if (version === CURRENT_PROTOCOL_VERSION)
						expect(await callResult(result)).toMatchObject(result);
					if (version !== CURRENT_PROTOCOL_VERSION)
						await expect(callResult(result)).rejects.toThrow(
							'MCP 2025 structuredContent must be a JSON object',
						);
				}

				const error = {
					code: -32602,
					message: 'Invalid params',
					data: {
						reason: 'kept',
					},
				};
				const callEnvelope = (reply: Record<string, unknown>, omitId = false) =>
					client.callTool(
						{
							name: 'echo',
							arguments: {
								fixtureMode: 'envelope',
								reply,
								omitId,
							},
						},
						undefined,
						{
							timeout: omitId ? 100 : 2000,
						},
					);
				await expect(
					callEnvelope({
						error,
					}),
				).rejects.toMatchObject({
					code: error.code,
					message: error.message,
					data: error.data,
				});
				for (const reply of [
					{},
					{
						id: 'wrong',
						error,
					},
					{
						jsonrpc: '1.0',
						error,
					},
					{
						error: {
							...error,
							code: -32602.5,
						},
					},
					{
						error: {
							...error,
							code: '-32602',
						},
					},
					{
						error: {
							...error,
							message: 1,
						},
					},
					{
						error: {
							message: 'Missing code',
						},
					},
					{
						result: {},
						error,
					},
					{
						result: null,
					},
					{
						result: [],
					},
					{
						method: 'tools/call',
						error,
					},
					{
						params: {},
						error,
					},
				])
					await expect(callEnvelope(reply)).rejects.toThrow();
				await expect(
					callEnvelope(
						{
							error,
						},
						true,
					),
				).rejects.toThrow();

				const sessions = createMcpSessionManager({
					protocolHeaderName: 'MCP-Protocol-Version',
					supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				});
				const manager = {
					callTool: () => callResult(validResult),
					listEnabledTools: () => new Map(),
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
										id: 0,
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
							id: 'call',
							method: 'tools/call',
							params: {
								name: 'fixture__echo',
							},
						},
						initial?.sessionId,
						externalVersion,
					);
					expect(
						response.payload &&
							'result' in response.payload &&
							response.payload.result.content,
					).toEqual(
						validToolContent.map((block) => {
							if (block.type === 'resource_link')
								return {
									...block,
									uri: addResourcePrefix({
										serverName: 'fixture',
										uri: block.uri,
									}),
								};
							if (block.type === 'resource')
								return {
									...block,
									resource: {
										...block.resource,
										uri: addResourcePrefix({
											serverName: 'fixture',
											uri: block.resource.uri,
										}),
									},
								};
							return block;
						}),
					);
				}
			} finally {
				await client.close();
				server?.stop(true);
			}
		});
	}

	test(`${version}: HTTP error envelopes validate before codes/data are forwarded`, async () => {
		let reply: Record<string, unknown> = {};
		let status = 400;
		const fetch = (request: Request): Promise<Response> =>
			request.json().then((body: unknown) =>
				Response.json(
					{
						jsonrpc: '2.0',
						id: recordOf(body)?.id,
						...reply,
					},
					{
						status,
					},
				),
			);
		const server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch,
		});
		const client = new ProtocolClient({
			serverName: 'error',
			serverConfig: {
				type: 'http',
				url: server.url.href,
				enabled: true,
				timeout: 1000,
				trafficLimit: 1000,
			},
		});
		client.protocolVersion = version;
		let recoveries = 0;
		client.ontransporterror = () => {
			recoveries++;
		};
		try {
			const error = {
				code: -32602,
				message: 'Invalid params',
				data: {
					kept: true,
				},
			};
			reply = {
				error,
			};
			await expect(
				client.callTool({
					name: 'echo',
				}),
			).rejects.toMatchObject({
				code: -32602,
				status: 400,
				data: error.data,
			});
			for (const malformed of [
				{
					id: null,
					error,
				},
				{
					id: undefined,
					error,
				},
				{
					id: 'wrong',
					error,
				},
				{
					jsonrpc: '1.0',
					error,
				},
				{
					result: {},
					error,
				},
				{
					error: {
						code: -32602.5,
						message: 'Invalid',
					},
				},
				{
					error: {
						code: '-32602',
						message: 'Invalid',
					},
				},
				{
					error: {
						code: -32602,
						message: null,
					},
				},
			]) {
				reply = malformed;
				let caught: unknown;
				try {
					await client.callTool({
						name: 'echo',
					});
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(Error);
				expect(caught).not.toBeInstanceOf(BackendRpcError);
			}
			expect(recoveries).toBe(0);
			for (const transientStatus of [
				408,
				429,
				503,
			]) {
				status = transientStatus;
				reply = {
					id: 'wrong',
					error: {
						code: 'invalid',
						message: null,
					},
				};
				await expect(
					client.callTool({
						name: 'echo',
					}),
				).rejects.toBeInstanceOf(BackendTransportError);
			}
			expect(recoveries).toBe(3);
		} finally {
			await client.close();
			server.stop(true);
		}
	});
}
