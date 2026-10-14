import type { Tool } from '@modelcontextprotocol/client';

import { createHandlers } from '@/server/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/server/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/server/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import type {
	CatalogRequest,
	EnabledTool,
	McpUpstreamManager,
} from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { toolHeaderParameters } from '@/shared/mcp_protocol';

import { mock } from 'bun:test';

// The catalog's view of these tools, for manager stubs.
const enabledTools = (serverName: string, tools: Tool[]): EnabledTool[] =>
	tools.map((tool) => ({
		serverName,
		tool,
		validateInput: () => undefined,
		headerParameters: toolHeaderParameters(tool.inputSchema),
	}));

// The manager's tool lookup over these tools, with the catalog's error.
const toolLookup =
	(tools: EnabledTool[]): McpUpstreamManager['getEnabledTool'] =>
	({ serverName, toolName }) => {
		const found = tools.find(
			(entry) =>
				entry.serverName === serverName && entry.tool.name === toolName,
		);
		if (!found)
			throw new BackendRpcError(
				`Tool "${toolName}" is unknown or disabled on MCP upstream "${serverName}"`,
				-32602,
			);
		return found;
	};

// Wires the public /mcp route like the server does.
const createRouteFixture = (
	manager: McpUpstreamManager,
	options: {
		refreshCatalogs?: (request: CatalogRequest) => Promise<void>;
	} = {},
) => {
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
	});
	const handlers = createHandlers({
		mcpUpstreamManager: manager,
	});
	const routeRequest = mock(
		createMcpRequestRouter({
			handlers,
			requireSession: sessions.requireSession,
			handleInitialize: sessions.handleInitialize,
		}),
	);
	const route = createMcpHttpRoute({
		refreshCatalogs: options.refreshCatalogs,
		mcpSessions: sessions,
		routeRequest,
		trafficStore: {
			logClientTraffic: () => undefined,
		} as unknown as TrafficStore,
	});
	return {
		route,
		routeRequest,
		sessions,
	};
};

// A POST to /mcp that accepts both response types, as the route requires.
const mcpPost = (init: RequestInit): Request => {
	const headers = new Headers(init.headers);
	if (!headers.has('Accept'))
		headers.set('Accept', 'application/json, text/event-stream');
	return new Request('http://localhost/mcp', {
		...init,
		method: 'POST',
		headers,
	});
};

export { createRouteFixture, enabledTools, mcpPost, toolLookup };
