import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

import type { McpUpstreamServer } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchResult = ReturnType<typeof fetch>;
type McpUpstreamTransport =
	| StreamableHTTPClientTransport
	| StdioClientTransport;

const isOptionalServerEventStreamRequest = (
	input: FetchInput,
	init?: FetchInit,
): boolean => {
	const requestMethod = input instanceof Request ? input.method : 'GET';
	const method = init?.method ?? requestMethod;
	if (method.toUpperCase() !== 'GET') return false;

	const requestHeaders = input instanceof Request ? input.headers : undefined;
	const headers = new Headers(init?.headers ?? requestHeaders);
	const accept = headers.get('accept');
	return accept?.includes('text/event-stream') ?? false;
};

const fetchWithoutOptionalServerEventStream = (
	input: FetchInput,
	init?: FetchInit,
): FetchResult => {
	if (!isOptionalServerEventStreamRequest(input, init)) {
		return fetch(input, init);
	}

	return Promise.resolve(
		new Response(null, {
			status: 405,
			statusText: 'Method Not Allowed',
		}),
	);
};

const createMcpUpstreamTransport = (
	server: McpUpstreamServer,
): McpUpstreamTransport => {
	const serverConfig = server.serverConfig;
	const transport =
		serverConfig.type === 'stdio'
			? new StdioClientTransport({
					command: serverConfig.command,
					args: serverConfig.args,
					env: serverConfig.env,
					cwd: serverConfig.cwd,
					stderr: 'pipe',
				})
			: new StreamableHTTPClientTransport(new URL(serverConfig.url), {
					requestInit: serverConfig.headers
						? {
								headers: serverConfig.headers as HeadersInit,
							}
						: undefined,
					fetch: fetchWithoutOptionalServerEventStream,
				});

	if (transport instanceof StdioClientTransport && transport.stderr) {
		transport.stderr.on('data', (chunk: Buffer) => {
			const line = chunk.toString().trimEnd();
			if (line) {
				logger.warn(`[stdio:${server.serverName}] ${line}`);
			}
		});
	}

	return transport;
};

export type { McpUpstreamTransport };
export { createMcpUpstreamTransport };
