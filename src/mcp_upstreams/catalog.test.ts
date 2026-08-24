import type { Client } from '@modelcontextprotocol/sdk/client';

import type { McpConfig } from '@/config/schema';
import { createMcpUpstreamCatalog } from '@/mcp_upstreams/catalog';
import type {
	McpUpstreamClientsMap,
	McpUpstreamPromptsMap,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamToolsMap,
} from '@/mcp_upstreams/types';

import { expect, test } from 'bun:test';

test('catalog responses invalidated by backend disable are discarded', async () => {
	const server: McpUpstreamServer = {
		serverName: 'catalog-race',
		serverConfig: {
			type: 'http',
			url: 'http://127.0.0.1/catalog-race',
			enabled: true,
			timeout: 10_000,
			trafficLimit: 1,
			enabledTools: [
				'alpha',
			],
		},
	};
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
	const clients: McpUpstreamClientsMap = new Map([
		[
			'catalog-race',
			client,
		],
	]);
	const config: McpConfig = {
		mcpServers: {
			[server.serverName]: server.serverConfig,
		},
	};
	const toolsCache: McpUpstreamToolsMap = new Map();
	const promptsCache: McpUpstreamPromptsMap = new Map();
	const resourcesCache: McpUpstreamResourcesMap = new Map();
	let configurationErrors = 0;
	let statusErrors = 0;
	const catalog = createMcpUpstreamCatalog({
		attemptReconnect: async () => undefined,
		clients,
		config,
		configErrorBackends: new Set(),
		getServer: () => server,
		markMcpUpstreamConfigurationError: () => {
			configurationErrors += 1;
		},
		onValidationError: () => undefined,
		promptsCache,
		resourcesCache,
		setMcpUpstreamStatusError: () => {
			statusErrors += 1;
		},
		toolsCache,
		waitForRateLimit: async () => undefined,
	});

	const refresh = Promise.all([
		catalog.fetchTools(server),
		catalog.fetchPrompts(server),
		catalog.fetchResources(server),
	]);
	await allStarted;
	server.serverConfig.enabled = false;
	clients.delete(server.serverName);
	releaseRequests();
	await refresh;

	expect(toolsCache.size).toBe(0);
	expect(promptsCache.size).toBe(0);
	expect(resourcesCache.size).toBe(0);
	expect(configurationErrors).toBe(0);
	expect(statusErrors).toBe(0);
});
