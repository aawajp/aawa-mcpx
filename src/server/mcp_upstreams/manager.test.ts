import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	type McpConfig,
	type McpServerConfig,
	mcpConfigType,
} from '@/server/config/schema';
import { logger } from '@/server/logger';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { ProtocolClient } from '@/server/mcp_upstreams/protocol_client';
import { fixtureReply } from '@/server/mcp_upstreams/protocol_fixture';
import { CURRENT_PROTOCOL_VERSION, recordOf } from '@/shared/mcp_protocol';
import type { McpUpstreamStatus } from '@/shared/ui_api';

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
									required: ['count'],
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
					enabledTools: ['alpha'],
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
		expect(startupDisabled).toMatchObject({
			enabled: false,
			enabledTools: ['alpha'],
			availableTools: ['alpha', 'beta'],
			connected: false,
			actionRequired: false,
		});
		expect(startupDisabled.error).toBeUndefined();
		expect(startupDisabled.implementation).toBeDefined();
		expect(
			toolNames(startupDisabledManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual(['alpha', 'beta']);
		expect(startupDisabledManager.listEnabledTools()).toEqual([]);
		expect(methods).toContain('tools/list');
		methods.length = 0;
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
			enabledTools: ['alpha'],
			connected: true,
		});
		expect(
			toolNames(runtimeManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual(['alpha', 'beta']);
		expect(
			runtimeManager.listEnabledTools().map(({ tool }) => tool.name),
		).toEqual(['alpha']);

		const beforeDisable = requireMockServer(await readConfig());
		expect(
			await runtimeManager.callTool({
				tool: runtimeManager.getEnabledTool({
					serverName: 'mock',
					toolName: 'alpha',
				}),
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
					tool: runtimeManager.getEnabledTool({
						serverName: 'mock',
						toolName: 'alpha',
					}),
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
		const connectedStatus = requireStatus(runtimeManager.getStatuses()[0]);
		await runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: false,
		});
		const afterDisableConfig = await readConfig();
		expect(close).toHaveBeenCalledTimes(1);
		close.mockClear();
		expect(Object.keys(afterDisableConfig.mcpServers)).toEqual(['mock']);
		const afterDisable = requireMockServer(afterDisableConfig);
		expect(afterDisable.enabled).toBe(false);
		expect(afterDisable.enabledTools).toEqual(beforeDisable.enabledTools);
		expect(afterDisable.availableTools).toEqual(beforeDisable.availableTools);
		expect(
			toolNames(runtimeManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual(['alpha', 'beta']);
		expect(runtimeManager.listEnabledTools()).toEqual([]);
		expect(runtimeManager.listEnabledPrompts().size).toBe(0);
		const runtimeDisabled = requireStatus(runtimeManager.getStatuses()[0]);
		expect(disabledState(runtimeDisabled)).toEqual({
			...disabledState(connectedStatus),
			enabled: false,
			connected: false,
		});
		expect(runtimeDisabled.implementation).toBeDefined();
		expect(runtimeDisabled.availableTools).toEqual(['alpha', 'beta']);

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
		expect(runtimeManager.listEnabledTools()).toEqual([]);
		expect(
			disabledState(requireStatus(runtimeManager.getStatuses()[0])),
		).toEqual(disabledState(runtimeDisabled));

		await runtimeManager.toggleBackend({
			serverName: 'mock',
			enabled: true,
		});
		const afterEnable = requireMockServer(await readConfig());
		expect(afterEnable.enabled).toBe(true);
		expect(afterEnable.enabledTools).toEqual(['alpha']);
		expect(runtimeManager.getStatuses()[0]).toMatchObject({
			enabled: true,
			enabledTools: ['alpha'],
			connected: true,
		});
		expect(
			toolNames(runtimeManager.listAllTools().get('mock')?.tools ?? []),
		).toEqual(['alpha', 'beta']);
		expect(
			runtimeManager.listEnabledTools().map(({ tool }) => tool.name),
		).toEqual(['alpha']);
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

test('every configured backend has a status as soon as startup begins', async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), 'mcpx-startup-'));
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const error = spyOn(logger, 'error').mockImplementation(() => undefined);
	const backend = (enabled: boolean) => ({
		type: 'http',
		url: 'http://127.0.0.1:1/mcp',
		enabled,
	});
	const manager = createMcpUpstreamManager({
		config: mcpConfigType.assert({
			mcpServers: {
				first: backend(true),
				second: backend(false),
			},
		}),
		configPath: path.join(testRoot, 'mcp.json'),
	});
	try {
		const initialization = manager.initialize();
		expect(
			manager.getStatuses().map((status) => ({
				serverName: status.serverName,
				connected: status.connected,
				error: status.error,
			})),
		).toEqual([
			{
				serverName: 'first',
				connected: false,
				error: undefined,
			},
			{
				serverName: 'second',
				connected: false,
				error: undefined,
			},
		]);
		await initialization;
	} finally {
		await manager.disconnect();
		warn.mockRestore();
		error.mockRestore();
		await rm(testRoot, {
			recursive: true,
			force: true,
		});
	}
});

test('refresh starts a stopped backend again', async () => {
	const testRoot = await mkdtemp(path.join(tmpdir(), 'mcpx-refresh-'));
	const error = spyOn(logger, 'error').mockImplementation(() => undefined);
	let authorized = false;
	const endpoint = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (!authorized)
				return new Response('Unauthorized', {
					status: 401,
				});
			const message = recordOf(await request.json()) ?? {};
			return Response.json(fixtureReply(message, CURRENT_PROTOCOL_VERSION));
		},
	});
	const configPath = path.join(testRoot, 'mcp.json');
	const config = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: endpoint.url.href,
				enabled: true,
			},
		},
	});
	await writeFile(configPath, JSON.stringify(config));
	const manager = createMcpUpstreamManager({
		config,
		configPath,
	});
	try {
		await manager.initialize();
		expect(manager.getStatuses()[0]).toMatchObject({
			connected: false,
			actionRequired: true,
		});
		authorized = true;
		await manager.refreshCatalogs({
			serverName: 'mock',
		});
		expect(manager.getStatuses()[0]).toMatchObject({
			connected: true,
			actionRequired: false,
		});
	} finally {
		await manager.disconnect();
		endpoint.stop(true);
		error.mockRestore();
		await rm(testRoot, {
			recursive: true,
			force: true,
		});
	}
});
