import { type } from 'arktype';

import type {
	Client,
	McpUpstreamServer,
	OnValidationError,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

const runLoggedRequest = async <T>(params: {
	server: McpUpstreamServer;
	client: Client;
	method: string;
	request: unknown;
	validationRequest: unknown;
	invoke: () => Promise<T>;
	validate: (result: T) => unknown;
	onValidationError: OnValidationError;
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
		const parsed = params.validate(result);
		if (parsed instanceof type.errors)
			params.onValidationError({
				server: params.server,
				method: params.method,
				error: parsed,
				request: params.validationRequest,
			});
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
