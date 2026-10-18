import type {
	GetPromptResult,
	ReadResourceResult,
} from '@modelcontextprotocol/client';

import type { TrafficStore } from '@/server/db/traffic';
import { runLoggedRequest } from '@/server/mcp_upstreams/logged_request';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import { createToolResultNormalizer } from '@/server/mcp_upstreams/tool_result';
import type {
	CallToolParams,
	Client,
	GetPromptParams,
	McpUpstreamBackend,
	ReadResourceParams,
} from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';
import { RPC_ERROR } from '@/shared/mcp_protocol';
import { type ToolCallResult, toolErrorResult } from '@/shared/mcp_results';

type CreateMcpUpstreamOperationsParams = {
	getBackend: (serverName: string) => McpUpstreamBackend | undefined;
	trafficStore?: TrafficStore;
	waitForRateLimit: (
		backend: McpUpstreamBackend,
		signal?: AbortSignal,
	) => Promise<void>;
};

// RPC errors retain their code/data; transport and malformed-response failures
// belong to the gateway's protocol boundary. Only a backend's explicit isError
// tool result represents a tool execution failure.
const wrapBackendFailure = async <T>(
	serverName: string,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		if (signal?.aborted || error instanceof BackendRpcError) throw error;
		throw new BackendRpcError(
			`MCP upstream "${serverName}" request failed: ${errorMessage(error)}`,
			RPC_ERROR.InternalError,
		);
	}
};

const createMcpUpstreamOperations = (
	params: CreateMcpUpstreamOperationsParams,
) => {
	const { getBackend, trafficStore, waitForRateLimit } = params;
	const normalizeToolResult = createToolResultNormalizer();

	// The enabled, connected backend a request goes to.
	const connectedBackend = (
		serverName: string,
		signal?: AbortSignal,
		unknownCode: number = RPC_ERROR.InvalidParams,
	) => {
		signal?.throwIfAborted();
		const server = getBackend(serverName);
		const client = server?.client;
		if (!server?.serverConfig.enabled)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is unknown or disabled`,
				unknownCode,
			);
		if (!client)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is not available`,
				RPC_ERROR.InternalError,
			);
		return {
			server,
			client,
		};
	};

	// Sends one request after the backend's rate limit and logs its traffic.
	const send = async <T>(params: {
		server: McpUpstreamBackend;
		client: Client;
		method: string;
		request: unknown;
		signal?: AbortSignal;
		invoke: () => Promise<T>;
	}): Promise<T> => {
		await waitForRateLimit(params.server, params.signal);
		params.signal?.throwIfAborted();
		return wrapBackendFailure(params.server.serverName, params.signal, () =>
			runLoggedRequest({
				...params,
				trafficStore,
			}),
		);
	};

	const callTool = async (
		callParams: CallToolParams,
	): Promise<ToolCallResult> => {
		const { args, signal } = callParams;
		const { serverName, tool, validateInput, headerParameters } =
			callParams.tool;
		const { server, client } = connectedBackend(serverName, signal);
		// The catalog compiled the schema once. Both dashboard and MCP calls
		// validate their arguments here exactly once, before any backend work.
		const inputIssue = validateInput(args);
		if (inputIssue) {
			if (inputIssue.reason !== 'schema_mismatch')
				throw new BackendRpcError(
					`Input validation unavailable: ${inputIssue.detail}`,
					RPC_ERROR.InternalError,
				);
			const message = `Invalid arguments for tool "${tool.name}": ${inputIssue.detail}`;
			// 2025-06-18 lists invalid arguments as protocol errors; 2025-11-25 and
			// 2026-07-28 report input validation failures as actionable tool errors.
			if (callParams.clientProtocolVersion === '2025-06-18')
				throw new BackendRpcError(message, RPC_ERROR.InvalidParams);
			return toolErrorResult(message);
		}
		const result = await send({
			server,
			client,
			method: `tools/call:${tool.name}`,
			request: args,
			signal,
			invoke: () =>
				client.callTool(
					{
						name: tool.name,
						arguments: args,
						_meta: callParams.metadata,
					},
					{
						mirroredHeaders: callParams.mirroredHeaders,
						headerParameters,
						signal,
					},
				),
		});
		return normalizeToolResult(result, tool.outputSchema, {
			backend: serverName,
			tool: tool.name,
			protocolVersion: client.protocolVersion,
		});
	};

	const getPrompt = async (
		promptParams: GetPromptParams,
	): Promise<GetPromptResult> => {
		const { serverName, promptName, args, signal } = promptParams;
		const { server, client } = connectedBackend(serverName, signal);
		return send({
			server,
			client,
			method: `prompts/get:${promptName}`,
			request: args,
			signal,
			invoke: () =>
				client.getPrompt(
					{
						name: promptName,
						arguments: args,
						_meta: promptParams.metadata,
					},
					{
						mirroredHeaders: promptParams.mirroredHeaders,
						signal,
					},
				),
		});
	};

	const readResource = async (
		resourceParams: ReadResourceParams,
	): Promise<ReadResourceResult> => {
		const { serverName, uri, signal } = resourceParams;
		// A resource of an unknown backend is not found; the router adapts the
		// code for 2026-07-28 clients.
		const { server, client } = connectedBackend(
			serverName,
			signal,
			RPC_ERROR.ResourceNotFound,
		);
		return send({
			server,
			client,
			method: `resources/read:${uri}`,
			request: {
				uri,
			},
			signal,
			invoke: () =>
				client.readResource(
					{
						uri,
						_meta: resourceParams.metadata,
					},
					{
						mirroredHeaders: resourceParams.mirroredHeaders,
						signal,
					},
				),
		});
	};

	return {
		callTool,
		getPrompt,
		readResource,
	};
};

export { createMcpUpstreamOperations };
