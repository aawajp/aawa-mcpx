import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import type { CatalogRequest, McpUpstreamManager } from '@/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/shared/mcp_protocol';

import { mock } from 'bun:test';

// Wires the public /mcp route like the server does.
const createRouteFixture = (
	manager: McpUpstreamManager,
	options: {
		refreshCatalogs?: (request: CatalogRequest) => Promise<void>;
	} = {},
) => {
	const sessions = createMcpSessionManager({
		protocolHeaderName: 'MCP-Protocol-Version',
		supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
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
		getToolSchema: (name) => handlers.findTool(name)?.inputSchema,
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

export { createRouteFixture, mcpPost };
