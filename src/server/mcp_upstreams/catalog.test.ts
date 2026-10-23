import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { McpConfig } from '@/server/config/schema';
import { createMcpUpstreamCatalog } from '@/server/mcp_upstreams/catalog';
import { createMcpUpstreamBackend } from '@/server/mcp_upstreams/connections';
import type { ProtocolClient as Client } from '@/server/mcp_upstreams/protocol_client';

import { afterAll, beforeAll, expect, it } from 'bun:test';

let root = '';
beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'mcpx-catalog-'));
});
afterAll(async () => {
	await rm(root, {
		recursive: true,
		force: true,
	});
});

it('catalog responses invalidated by backend disable are discarded', async () => {
	const server = createMcpUpstreamBackend({
		serverName: 'catalog-race',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/catalog-race',
			enabled: true,
			timeout: 10_000,
			trafficLimit: 1,
			enabledTools: ['alpha'],
		},
	});
	let startedRequests = 0;
	let signalAllStarted = (): void => undefined;
	let releaseRequests = (): void => undefined;
	const allStarted = new Promise<void>((resolve) => {
		signalAllStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		releaseRequests = resolve;
	});
	const waitForRelease = async (): Promise<void> => {
		startedRequests += 1;
		if (startedRequests === 3) signalAllStarted();
		await released;
	};
	const client = {
		getServerCapabilities: () => ({
			tools: {},
			prompts: {},
			resources: {},
		}),
		async listTools() {
			await waitForRelease();
			return {
				tools: [
					{
						name: 'alpha',
						inputSchema: {
							type: 'object',
						},
					},
				],
			};
		},
		async listPrompts() {
			await waitForRelease();
			return {
				prompts: [],
			};
		},
		async listResources() {
			await waitForRelease();
			return {
				resources: [],
			};
		},
	} as unknown as Client;
	server.client = client;
	const config: McpConfig = {
		mcpServers: {
			[server.serverName]: server.serverConfig,
		},
	};
	let configurationErrors = 0;
	let statusErrors = 0;
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: async () => undefined,
		configPath: path.join(root, 'mcp.json'),
		backends: new Map([[server.serverName, server]]),
		config,
		markMcpUpstreamConfigurationError: () => {
			configurationErrors += 1;
		},
		setMcpUpstreamStatusError: () => {
			statusErrors += 1;
		},
		waitForRateLimit: async () => undefined,
	});

	const refresh = Promise.all([
		catalog.fetchTools(server),
		catalog.fetchPrompts(server),
		catalog.fetchResources(server),
	]);
	await allStarted;
	server.serverConfig.enabled = false;
	server.client = undefined;
	releaseRequests();
	await refresh;

	expect(server.tools).toBeUndefined();
	expect(server.prompts).toBeUndefined();
	expect(server.resources).toBeUndefined();
	expect(configurationErrors).toBe(0);
	expect(statusErrors).toBe(0);
});

it('lists a backend does not advertise are never requested', async () => {
	const server = createMcpUpstreamBackend({
		serverName: 'tools-only',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/tools-only',
			enabled: true,
			timeout: 10_000,
			trafficLimit: 1,
		},
	});
	const unexpected = async (): Promise<never> => {
		throw new Error('Unadvertised list requested');
	};
	server.client = {
		getServerCapabilities: () => ({
			tools: {},
		}),
		listPrompts: unexpected,
		listResources: unexpected,
	} as unknown as Client;
	server.prompts = {
		prompts: [],
	};
	let statusErrors = 0;
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: async () => undefined,
		configPath: path.join(root, 'mcp.json'),
		backends: new Map([[server.serverName, server]]),
		config: {
			mcpServers: {
				[server.serverName]: server.serverConfig,
			},
		},
		markMcpUpstreamConfigurationError: () => undefined,
		setMcpUpstreamStatusError: () => {
			statusErrors += 1;
		},
		waitForRateLimit: async () => undefined,
	});

	await Promise.all([
		catalog.fetchPrompts(server),
		catalog.fetchResources(server),
	]);

	expect(server.prompts).toBeUndefined();
	expect(server.resources).toBeUndefined();
	expect(statusErrors).toBe(0);
});

it('MCP lists and tool lookups skip disabled backends and backends with a configuration error', async () => {
	const createBackend = (serverName: string, enabled: boolean) => {
		const backend = createMcpUpstreamBackend({
			serverName,
			serverConfig: {
				type: 'http',
				url: `http://127.0.0.1/${serverName}`,
				enabled,
				timeout: 10_000,
				trafficLimit: 1,
			},
		});
		backend.client = {
			getServerCapabilities: () => ({
				tools: {},
			}),
			listTools: async () => ({
				tools: [
					{
						name: 'alpha',
						inputSchema: {
							type: 'object',
						},
					},
				],
			}),
		} as unknown as Client;
		backend.prompts = {
			prompts: [
				{
					name: 'greet',
				},
			],
		};
		backend.resources = {
			resources: [
				{
					name: 'example',
					uri: 'file:///example',
				},
			],
		};
		backend.resourceTemplates = {
			resourceTemplates: [
				{
					name: 'logs',
					uriTemplate: 'file:///logs/{name}',
				},
			],
		};
		return backend;
	};
	const broken = createBackend('broken', true);
	broken.configError = true;
	const backends = new Map(
		[createBackend('ok', true), createBackend('off', false), broken].map(
			(backend) => [backend.serverName, backend],
		),
	);
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: async () => undefined,
		configPath: path.join(root, 'mcp.json'),
		backends,
		config: {
			mcpServers: Object.fromEntries(
				[...backends.values()].map((backend) => [
					backend.serverName,
					backend.serverConfig,
				]),
			),
		},
		markMcpUpstreamConfigurationError: () => undefined,
		setMcpUpstreamStatusError: () => undefined,
		waitForRateLimit: async () => undefined,
	});

	// Fetching compiles each tool; a fetch clears configError when enabledTools
	// is valid, so mark the broken backend afterwards.
	for (const backend of backends.values()) await catalog.fetchTools(backend);
	broken.configError = true;

	const all = ['ok', 'off', 'broken'];
	expect([...catalog.listAllTools().keys()]).toEqual(all);
	expect([...catalog.listAllPrompts().keys()]).toEqual(all);
	expect([...catalog.listAllResources().keys()]).toEqual(all);
	expect(
		catalog
			.listEnabledTools()
			.map(({ serverName, tool }) => `${serverName}/${tool.name}`),
	).toEqual(['ok/alpha']);
	expect(
		catalog.getEnabledTool({
			serverName: 'ok',
			toolName: 'alpha',
		}).tool.name,
	).toBe('alpha');
	for (const serverName of ['off', 'broken', 'missing'])
		expect(() =>
			catalog.getEnabledTool({
				serverName,
				toolName: 'alpha',
			}),
		).toThrow('is unknown or disabled');
	expect([...catalog.listEnabledPrompts().keys()]).toEqual(['ok']);
	expect([...catalog.listEnabledResources().keys()]).toEqual(['ok']);
	expect([...catalog.listEnabledResourceTemplates().keys()]).toEqual(['ok']);
});
