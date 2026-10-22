import type { TrafficStore } from '@/server/db/traffic';
import { logger } from '@/server/logger';
import type { Client, McpUpstreamServer } from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';

const runLoggedRequest = async <T>(params: {
	server: McpUpstreamServer;
	client: Client;
	method: string;
	request: unknown;
	invoke: () => Promise<T>;
	trafficStore?: TrafficStore;
	signal?: AbortSignal;
}): Promise<T> => {
	const log = (response: unknown): void =>
		params.trafficStore?.logBackendTraffic({
			protocolVersion: params.client.protocolVersion,
			backend: params.server.serverName,
			method: params.method,
			request: params.request,
			response,
		});
	try {
		const result = await params.invoke();
		params.signal?.throwIfAborted();
		log(result);
		return result;
	} catch (error) {
		// Caller cancellation is an expected lifecycle event, not a backend fault.
		if (params.signal?.aborted) throw error;
		logger.error(
			JSON.stringify({
				message: 'MCP upstream request failed',
				context: {
					backend: params.server.serverName,
					method: params.method,
				},
				error: errorMessage(error),
			}),
		);
		log({
			error: errorMessage(error),
		});
		// Keep RPC errors intact; the gateway forwards their code and data.
		throw error;
	}
};

export { runLoggedRequest };
