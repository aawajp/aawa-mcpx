import Ajv2020 from 'ajv/dist/2020';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mcpConfigType } from '@/server/config/schema';
import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { createUiRoutes } from '@/server/gateway/ui_routes';
import { logger } from '@/server/logger';
import { createMcpUpstreamBackend } from '@/server/mcp_upstreams/connections';
import { createInputSchemaCompiler } from '@/server/mcp_upstreams/input_schema';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { createMcpUpstreamOperations } from '@/server/mcp_upstreams/method_calls';
import { ProtocolClient } from '@/server/mcp_upstreams/protocol_client';
import { startFixtureBackend } from '@/server/mcp_upstreams/protocol_fixture';
import type { McpUpstreamServer } from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import {
	CURRENT_PROTOCOL_VERSION,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, mock, spyOn, test } from 'bun:test';

test('the shared call path validates arguments exactly once before backend work', async () => {
	const compiled = createInputSchemaCompiler()({
		type: 'object',
		required: ['count'],
	});
	if ('issue' in compiled) throw new Error(compiled.issue.detail);
	const validate = spyOn(compiled, 'validate');
	const invoke = mock(async () => ({
		content: [],
	}));
	const waitForRateLimit = mock(async () => undefined);
	const server: McpUpstreamServer = {
		serverName: 'fixture',
		serverConfig: {
			type: 'http',
			url: 'http://localhost',
			enabled: true,
			timeout: 1000,
			trafficLimit: 1000,
		},
	};
	const client = {
		callTool: invoke,
		protocolVersion: CURRENT_PROTOCOL_VERSION,
	} as unknown as ProtocolClient;
	const operations = createMcpUpstreamOperations({
		getBackend: () => ({
			...createMcpUpstreamBackend(server),
			client,
		}),
		getEnabledTool: ({ toolName }) =>
			toolName === 'echo'
				? {
						tool: {
							name: 'echo',
							inputSchema: {
								type: 'object',
							},
						},
						inputValidator: compiled,
					}
				: undefined,
		waitForRateLimit,
	});
	try {
		await operations.callTool({
			serverName: 'fixture',
			toolName: 'echo',
			args: {
				count: 1,
			},
		});
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			const call = operations.callTool({
				serverName: 'fixture',
				toolName: 'echo',
				args: {},
				clientProtocolVersion: version,
			});
			if (version === '2025-06-18')
				await expect(call).rejects.toMatchObject({
					code: -32602,
				});
			else
				expect(await call).toMatchObject({
					isError: true,
				});
		}
		expect(validate).toHaveBeenCalledTimes(4);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(waitForRateLimit).toHaveBeenCalledTimes(1);
	} finally {
		validate.mockRestore();
	}
});

for (const backendVersion of SUPPORTED_PROTOCOL_VERSIONS) {
	for (const transport of ['http', 'stdio'] as const) {
		test(`${backendVersion} ${transport}: schemas gate exposure and calls across client revisions and refreshes`, async () => {
			const root = await mkdtemp(path.join(tmpdir(), 'mcpx-input-'));
			const catalogPath = path.join(root, 'tools.json');
			const schema = (minimum: number) => ({
				$id: 'urn:fixture:input',
				type: 'object',
				$defs: {
					count: {
						type: 'integer',
						minimum,
					},
				},
				properties: {
					count: {
						$ref: '#/$defs/count',
					},
					mode: {
						enum: ['short', 'long'],
					},
					choice: {
						oneOf: [
							{
								const: 'auto',
							},
							{
								type: 'integer',
								minimum: 1,
							},
						],
					},
					limit: {
						type: 'integer',
						default: 5,
					},
				},
				required: ['count', 'mode', 'choice'],
			});
			const badSchemas = [
				null,
				true,
				[],
				{},
				{
					type: 'string',
				},
				{
					type: 'object',
					properties: {
						bad: {
							type: 'invalid',
						},
					},
				},
				{
					type: 'object',
					$schema: 'https://example.invalid/dialect',
				},
				{
					type: 'object',
					$ref: 'https://example.invalid/schema',
				},
			];
			await Bun.write(
				catalogPath,
				JSON.stringify([
					{
						name: 'echo',
						inputSchema: schema(1),
					},
					...badSchemas.map((inputSchema, i) => ({
						name: `bad${i}`,
						inputSchema,
					})),
				]),
			);
			const backend = startFixtureBackend(transport, backendVersion, {
				catalogPath,
			});
			const config = mcpConfigType.assert({
				mcpServers: {
					fixture: {
						...backend.config,
						timeout: 2000,
						trafficLimit: 10000,
					},
				},
			});
			const manager = createMcpUpstreamManager({
				config,
				configPath: path.join(root, 'mcp.json'),
			});
			const compile = spyOn(Ajv2020.prototype, 'compile');
			const invoke = spyOn(ProtocolClient.prototype, 'callTool');
			const warn = spyOn(logger, 'warn');
			try {
				await manager.initialize();
				expect(manager.getStatuses()[0]).toMatchObject({
					connected: true,
					protocolVersion: backendVersion,
				});
				expect(manager.listAllTools().get('fixture')?.tools).toHaveLength(9);
				expect(
					manager
						.listEnabledTools()
						.get('fixture')
						?.tools.map((tool) => tool.name),
				).toEqual(['echo']);
				expect(
					warn.mock.calls.filter(([message]) =>
						String(message).includes('Tool input schema is unusable'),
					),
				).toHaveLength(8);
				const compilations = compile.mock.calls.length;
				expect(compilations).toBeGreaterThan(0);
				const sessions = createMcpSessionManager({
					protocolHeaderName: 'MCP-Protocol-Version',
					supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				});
				const route = createMcpRequestRouter({
					handlers: createHandlers({
						mcpUpstreamManager: manager,
					}),
					requireSession: sessions.requireSession,
					handleInitialize: sessions.handleInitialize,
				});
				const valid = {
					count: 2,
					mode: 'short',
					choice: 'auto',
					text: 'hello',
					extra: 'preserved',
				};
				for (const clientVersion of SUPPORTED_PROTOCOL_VERSIONS) {
					const initial =
						clientVersion === CURRENT_PROTOCOL_VERSION
							? undefined
							: await sessions.handleInitialize(
									{
										jsonrpc: '2.0',
										id: 0,
										method: 'initialize',
										params: {
											protocolVersion: clientVersion,
											clientInfo: {
												name: 'input-test',
												version: '1',
											},
										},
									},
									undefined,
								);
					const call = (args?: unknown, name = 'echo') =>
						route(
							{
								jsonrpc: '2.0',
								id: 'call',
								method: 'tools/call',
								params: {
									name: `fixture__${name}`,
									...(args === undefined
										? {}
										: {
												arguments: args,
											}),
								},
							},
							{
								sessionId: initial?.sessionId,
								protocolVersion: clientVersion,
							},
						);
					const catalog = await route(
						{
							jsonrpc: '2.0',
							id: 'list',
							method: 'tools/list',
						},
						{
							sessionId: initial?.sessionId,
							protocolVersion: clientVersion,
						},
					);
					expect(
						recordOf(recordOf(catalog.payload)?.result)?.tools,
					).toHaveLength(1);
					expect(recordOf((await call(valid)).payload)?.result).toMatchObject({
						content: [
							{
								type: 'text',
								text: 'hello',
							},
						],
					});
					expect(invoke.mock.calls.at(-1)?.[0].arguments).toEqual(valid);
					const sent = invoke.mock.calls.length;
					for (const args of [
						undefined,
						{},
						{
							...valid,
							count: '2',
						},
						{
							...valid,
							count: 0,
						},
						{
							...valid,
							mode: 'unknown',
						},
						{
							...valid,
							choice: false,
						},
					]) {
						const response = await call(args);
						if (clientVersion === '2025-06-18')
							expect(recordOf(response.payload)?.error).toMatchObject({
								code: -32602,
							});
						else
							expect(recordOf(response.payload)?.result).toMatchObject({
								isError: true,
							});
					}
					// Malformed arguments are protocol errors, distinct from well-formed
					// objects that fail a provider's schema, in every client revision.
					for (const args of [[], null, 'text'])
						expect(recordOf((await call(args)).payload)?.error).toMatchObject({
							code: -32602,
						});
					for (let i = 0; i < badSchemas.length; i++)
						expect(
							recordOf((await call({}, `bad${i}`)).payload)?.error,
						).toMatchObject({
							code: -32603,
						});
					expect(invoke.mock.calls).toHaveLength(sent);
				}
				const ui = createUiRoutes({
					mcpUpstreamManager: manager,
					buildOverview: () => ({}),
					shutdownSignal: new AbortController().signal,
					trafficStore: {} as unknown as TrafficStore,
				});
				const uiCall = (args: unknown) =>
					ui['/api/tools/call'].POST(
						new Request('http://localhost/api/tools/call', {
							method: 'POST',
							body: JSON.stringify({
								serverName: 'fixture',
								toolName: 'echo',
								arguments: args,
							}),
						}),
					);
				const sent = invoke.mock.calls.length;
				expect((await uiCall([])).status).toBe(400);
				expect((await (await uiCall({})).json()).result).toMatchObject({
					isError: true,
				});
				expect(invoke.mock.calls).toHaveLength(sent);
				expect((await (await uiCall(valid)).json()).result).not.toHaveProperty(
					'isError',
				);
				expect(compile.mock.calls).toHaveLength(compilations);
				// Refresh changes constraints and repairs an unusable tool. Same $id
				// is legal: new catalog objects get independent compiled validators.
				await Bun.write(
					catalogPath,
					JSON.stringify([
						{
							name: 'echo',
							inputSchema: schema(10),
						},
						{
							name: 'bad0',
							inputSchema: {
								type: 'object',
							},
						},
					]),
				);
				await manager.refreshCatalogs({
					serverName: 'fixture',
				});
				expect(compile.mock.calls.length).toBeGreaterThan(compilations);
				const refreshedCompilations = compile.mock.calls.length;
				expect(
					manager
						.listEnabledTools()
						.get('fixture')
						?.tools.map((tool) => tool.name),
				).toEqual(['echo', 'bad0']);
				expect((await (await uiCall(valid)).json()).result).toMatchObject({
					isError: true,
				});
				expect(
					(
						await (
							await uiCall({
								...valid,
								count: 10,
							})
						).json()
					).result,
				).not.toHaveProperty('isError');
				expect(
					await manager.callTool({
						serverName: 'fixture',
						toolName: 'bad0',
						args: {},
					}),
				).not.toHaveProperty('isError');
				expect(compile.mock.calls).toHaveLength(refreshedCompilations);
				const persisted = mcpConfigType.assert(
					await Bun.file(path.join(root, 'mcp.json')).json(),
				);
				expect(persisted.mcpServers.fixture?.enabledTools).toEqual([
					'echo',
					'bad0',
				]);
				expect(manager.getStatuses()[0]?.connected).toBe(true);
			} finally {
				compile.mockRestore();
				invoke.mockRestore();
				warn.mockRestore();
				await manager.disconnect();
				backend.stop();
				await rm(root, {
					recursive: true,
					force: true,
				});
			}
		});
	}
}
