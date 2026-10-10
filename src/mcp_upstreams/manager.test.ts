import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	type McpConfig,
	type McpServerConfig,
	mcpConfigType,
} from '@/config/schema';
import { createMcpUpstreamManager } from '@/mcp_upstreams/manager';
import { ProtocolClient } from '@/mcp_upstreams/protocol_client';
import type { McpUpstreamStatus } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';

import { expect, spyOn, test } from 'bun:test';

type JsonRpcRequest = {
	id?: string | number;
	method?: string;
	params?: unknown;
};

type InitializeBarrier = {
	started: Promise<void>;
	released: Promise<void>;
	signalStarted: () => void;
	release: () => void;
};

const createInitializeBarrier = (): InitializeBarrier => {
	let signalStarted = (): void => undefined;
	let release = (): void => undefined;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		started,
		released,
		signalStarted,
		release,
	};
};

const toolNames = (
	tools: Array<{
		name: string;
	}>,
): string[] => tools.map((tool) => tool.name);

const disabledState = (status: McpUpstreamStatus) => ({
	enabled: status.enabled,
	enabledTools: status.enabledTools,
	connected: status.connected,
	error: status.error,
	errorState: status.errorState,
	actionRequired: status.actionRequired,
	implementation: status.implementation,
	capabilities: status.capabilities,
	instructions: status.instructions,
});

const requireStatus = (
	status: McpUpstreamStatus | undefined,
): McpUpstreamStatus => {
	if (!status) {
		throw new Error('Expected backend status');
	}
	return status;
};

const requireMockServer = (config: McpConfig): McpServerConfig => {
	const server = config.mcpServers.mock;
	if (!server) {
		throw new Error('Expected mock backend config');
	}
	return server;
};

test('backend lifecycle preserves tool exposure state', async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), 'mcpx-lifecycle-'));
	const configPath = path.join(testRoot, 'mcp.json');
	const methods: string[] = [];
	let returnedCount: number | string = 2;
	let initializeBarrier: InitializeBarrier | null = null;
	const mockServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			if (request.method !== 'POST') {
				return new Response(null, {
					status: request.method === 'DELETE' ? 202 : 405,
				});
			}

			const message = (await request.json()) as JsonRpcRequest;
			if (!message.method) {
				return new Response('Bad Request', {
					status: 400,
				});
			}
			methods.push(message.method);
			if (message.id === undefined) {
				return new Response(null, {
					status: 202,
				});
			}

			let result: unknown;
			if (message.method === 'server/discover')
				return Response.json(
					{
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32600,
							message: 'Initialize first',
						},
					},
					{
						status: 400,
					},
				);
			switch (message.method) {
				case 'initialize': {
					const barrier = initializeBarrier;
					if (barrier) {
						initializeBarrier = null;
						barrier.signalStarted();
						await barrier.released;
					}
					const params =
						typeof message.params === 'object' && message.params !== null
							? (message.params as Record<string, unknown>)
							: {};
					result = {
						protocolVersion:
							typeof params.protocolVersion === 'string'
								? params.protocolVersion
								: '2025-11-25',
						capabilities: {
							prompts: {},
							resources: {},
							tools: {},
						},
						serverInfo: {
							name: 'mock-backend',
							version: '1.0.0',
						},
					};
					break;
				}
				case 'tools/list':
					result = {
						tools: [
							{
								name: 'alpha',
								outputSchema: {
									type: 'object',
									properties: {
										count: {
											type: 'integer',
										},
									},
									required: [
										'count',
									],
								},
								inputSchema: {
									type: 'object',
								},
							},
							{
								name: 'beta',
								inputSchema: {
									type: 'object',
								},
							},
						],
					};
					break;
				case 'prompts/list':
					result = {
						prompts: [],
					};
					break;
				case 'resources/list':
					result = {
						resources: [],
					};
					break;
				case 'ping':
					result = {};
					break;
				case 'tools/call':
					result = {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									count: returnedCount,
								}),
							},
							{
								type: 'text',
								text: 'Two items found.',
							},
						],
						structuredContent: {
							count: returnedCount,
						},
					};
					break;
				default:
					return Response.json({
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32601,
							message: 'Method not found',
						},
					});
			}

			return Response.json({
				jsonrpc: '2.0',
				id: message.id,
				result,
			});
		},
	});

	const url = `http://127.0.0.1:${mockServer.port}/mcp`;
	const createConfig = (enabled: boolean) =>
		mcpConfigType.assert({
			mcpServers: {
				mock: {
					type: 'http',
					url,
					enabled,
					trafficLimit: 1000,
					enabledTools: [
						'alpha',
					],
				},
			},
		});
	const writeConfig = async (enabled: boolean): Promise<void> => {
		await writeFile(
			configPath,
			`${JSON.stringify(createConfig(enabled), null, '\t')}\n`,
		);
	};
	const readConfig = async () => {
		const config: unknown = await Bun.file(configPath).json();
		return mcpConfigType.assert(config);
	};
	let startupDisabledManager: ReturnType<
		typeof createMcpUpstreamManager
	> | null = null;
	let runtimeManager: ReturnType<typeof createMcpUpstreamManager> | null = null;

	try {
		await writeConfig(false);
		startupDisabledManager = createMcpUpstreamManager({
			config: createConfig(false),
			configPath,
		});
		await startupDisabledManager.initialize();
		const startupDisabled = requireStatus(
			startupDisabledManager.getStatuses()[0],
		);
		expect(disabledState(startupDisabled)).toEqual({
			enabled: false,
			enabledTools: [
				'alpha',
			],
			connected: false,
			error: undefined,
			errorState: undefined,
			actionRequired: false,
			implementation: undefined,
			capabilities: undefined,
			instructions: undefined,
		});
		expect(startupDisabledManager.listAllTools().size).toBe(0);
		expect(methods).toEqual([]);
		await startupDisabledManager.disconnect();
		startupDisabledManager = null;

		await writeConfig(true);
		runtimeManager = createMcpUpstreamManager({
			config: createConfig(true),
			configPath,
		});
		await runtimeManager.initialize();
		expect(runtimeManager.getStatuses()[0]).toMatchObject({
			enabled: true,
			enabledTools: [
				'alpha',
			],
			connected: true,
		});
		expect(
			toolNames(runtimeManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual([
			'alpha',
			'beta',
		]);
		expect(
			toolNames(runtimeManager.listEnabledTools().get('mock')?.tools ?? []),
		).toEqual([
			'alpha',
		]);

		const beforeDisable = requireMockServer(await readConfig());
		expect(
			await runtimeManager.callTool({
				serverName: 'mock',
				toolName: 'alpha',
				args: {},
			}),
		).toEqual({
			content: [
				{
					type: 'text',
					text: 'Two items found.',
				},
			],
			structuredContent: {
				count: 2,
			},
		});
		returnedCount = 'provider-mismatch';
		const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
		try {
			expect(
				await runtimeManager.callTool({
					serverName: 'mock',
					toolName: 'alpha',
					args: {},
				}),
			).toEqual({
				content: [
					{
						type: 'text',
						text: 'Two items found.',
					},
				],
				structuredContent: {
					count: 'provider-mismatch',
				},
			});
			expect(warning).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
				message: 'MCP tool output schema warning',
				context: {
					backend: 'mock',
					tool: 'alpha',
					reason: 'schema_mismatch',
				},
			});
			expect(runtimeManager.getStatuses()[0]?.connected).toBe(true);
		} finally {
			warning.mockRestore();
			returnedCount = 2;
		}
		const close = spyOn(ProtocolClient.prototype, 'close');
		await writeFile(
			configPath,
			`${JSON.stringify(
				mcpConfigType.assert({
					mcpServers: {
						externalEdit: {
							type: 'http',
							url,
							enabled: true,
						},
					},
				}),
				null,
				'\t',
			)}\n`,
		);
		await runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: false,
		});
		const afterDisableConfig = await readConfig();
		expect(close).toHaveBeenCalledTimes(1);
		close.mockClear();
		expect(Object.keys(afterDisableConfig.mcpServers)).toEqual([
			'mock',
		]);
		const afterDisable = requireMockServer(afterDisableConfig);
		expect(afterDisable.enabled).toBe(false);
		expect(afterDisable.enabledTools).toEqual(beforeDisable.enabledTools);
		expect(afterDisable.availableTools).toEqual(beforeDisable.availableTools);
		expect(runtimeManager.listAllTools().size).toBe(0);
		const runtimeDisabled = requireStatus(runtimeManager.getStatuses()[0]);
		expect(disabledState(runtimeDisabled)).toEqual(
			disabledState(startupDisabled),
		);

		const barrier = createInitializeBarrier();
		initializeBarrier = barrier;
		const staleEnable = runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: true,
		});
		await barrier.started;
		await runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: false,
		});
		barrier.release();
		await staleEnable;
		expect(requireMockServer(await readConfig()).enabled).toBe(false);
		expect(runtimeManager.getStatuses()[0]?.connected).toBe(false);
		expect(runtimeManager.listAllTools().size).toBe(0);
		expect(
			disabledState(requireStatus(runtimeManager.getStatuses()[0])),
		).toEqual(disabledState(startupDisabled));

		await runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: true,
		});
		const afterEnable = requireMockServer(await readConfig());
		expect(afterEnable.enabled).toBe(true);
		expect(afterEnable.enabledTools).toEqual([
			'alpha',
		]);
		expect(runtimeManager.getStatuses()[0]).toMatchObject({
			enabled: true,
			enabledTools: [
				'alpha',
			],
			connected: true,
		});
		expect(
			toolNames(runtimeManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual([
			'alpha',
			'beta',
		]);
		expect(
			toolNames(runtimeManager.listEnabledTools().get('mock')?.tools ?? []),
		).toEqual([
			'alpha',
		]);
		expect(methods.filter((method) => method === 'initialize')).toHaveLength(3);
		expect(
			methods.filter((method) => method === 'server/discover'),
		).toHaveLength(1);
		expect(runtimeManager.getStatuses()[0]?.protocolVersion).toBe('2025-11-25');
		close.mockClear();
		await runtimeManager.disconnect();
		expect(close).toHaveBeenCalledTimes(1);
		close.mockRestore();
		runtimeManager = null;
	} finally {
		await startupDisabledManager?.disconnect();
		await runtimeManager?.disconnect();
		mockServer.stop(true);
		await rm(testRoot, {
			recursive: true,
			force: true,
		});
	}
});

test('a refresh pending across a reconnect does not leave an empty catalog', async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), 'mcpx-refresh-'));
	const configPath = path.join(testRoot, 'mcp.json');
	const mockServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			if (request.method !== 'POST')
				return new Response(null, {
					status: request.method === 'DELETE' ? 202 : 405,
				});
			const message = (await request.json()) as JsonRpcRequest;
			if (message.id === undefined)
				return new Response(null, {
					status: 202,
				});
			const reply = (result: unknown): Response =>
				Response.json({
					jsonrpc: '2.0',
					id: message.id,
					result,
				});
			switch (message.method) {
				case 'initialize':
					return reply({
						protocolVersion: '2025-11-25',
						capabilities: {
							tools: {},
						},
						serverInfo: {
							name: 'mock-backend',
							version: '1',
						},
					});
				case 'tools/list':
					return reply({
						tools: [
							{
								name: 'alpha',
								inputSchema: {
									type: 'object',
								},
							},
						],
					});
				default:
					return Response.json({
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32601,
							message: 'Method not found',
						},
					});
			}
		},
	});
	const config = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: `http://127.0.0.1:${mockServer.port}/mcp`,
				enabled: true,
				// The refresh below waits 500 ms for its rate-limit slot.
				trafficLimit: 2,
			},
		},
	});
	await writeFile(configPath, `${JSON.stringify(config, null, '\t')}\n`);
	const manager = createMcpUpstreamManager({
		config,
		configPath,
	});
	try {
		await manager.initialize();
		const staleRefresh = manager
			.refreshCatalogs({
				serverName: 'mock',
			})
			.catch(() => undefined);
		await Bun.sleep(50);
		await manager.toggleBackend({
			serverName: 'mock',
			enabled: false,
		});
		await manager.toggleBackend({
			serverName: 'mock',
			enabled: true,
		});
		await staleRefresh;
		expect(toolNames(manager.listAllTools().get('mock')?.tools ?? [])).toEqual([
			'alpha',
		]);
	} finally {
		await manager.disconnect();
		mockServer.stop(true);
		await rm(testRoot, {
			recursive: true,
			force: true,
		});
	}
});
