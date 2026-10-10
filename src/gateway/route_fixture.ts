import { createHandlers } from '@/gateway/mcp_handlers';
import { createMcpHttpRoute } from '@/gateway/mcp_http_route';
import { createMcpRequestRouter } from '@/gateway/mcp_request_router';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import type { CatalogRequest, McpUpstreamManager } from '@/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import {
	CURRENT_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { mock } from 'bun:test';

// Wires the public /mcp route like the server does, with Origin, Accept and
// logging checks stubbed out.
const createRouteFixture = (
	manager: McpUpstreamManager,
	options: {
		beforeRequest?: (request: CatalogRequest) => Promise<void>;
		// Check x-mcp-header mirrors against the listed tool schemas.
		checkToolHeaders?: boolean;
	} = {},
) => {
	const { beforeRequest } = options;
	const sessions = createMcpSessionManager({
		protocolHeaderName: 'MCP-Protocol-Version',
		supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
	});
	const handlers = createHandlers({
		mcpUpstreamManager: manager,
	});
	const routeRequest = mock(
		createMcpRequestRouter({
			beforeRequest,
			handlers,
			requireSession: sessions.requireSession,
			handleInitialize: sessions.handleInitialize,
		}),
	);
	const route = createMcpHttpRoute({
		getToolSchema: options.checkToolHeaders
			? (name) =>
					handlers
						.listTools(CURRENT_PROTOCOL_VERSION)
						.tools.find((tool) => tool.name === name)?.inputSchema
			: undefined,
		refreshCatalogs: beforeRequest,
		acceptsContentType: () => true,
		buildInboundMessageLog: () => '',
		buildLogFields: () => '',
		createJsonResponse: (body, session, status) =>
			Response.json(body, {
				status: status ?? 200,
				headers: session
					? {
							'Mcp-Session-Id': session,
						}
					: {},
			}),
		createMethodNotAllowedResponse: () =>
			new Response(null, {
				status: 405,
			}),
		createNotificationResponse: () =>
			new Response(null, {
				status: 202,
			}),
		createOriginForbiddenResponse: () =>
			new Response(null, {
				status: 403,
			}),
		isValidOrigin: () => true,
		logResponseError: () => undefined,
		mcpSessions: sessions,
		parseSessionId: (request) =>
			request.headers.get('Mcp-Session-Id') ?? undefined,
		routeRequest,
		trafficStore: {
			logClientTraffic: () => undefined,
		} as unknown as TrafficStore,
		waitForInitialization: async () => null,
	});
	return {
		route,
		routeRequest,
		sessions,
	};
};

export { createRouteFixture };
