import type {
	GetPromptResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types';

import { runLoggedRequest } from '@/server/mcp_upstreams/logged_request';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import { createToolResultNormalizer } from '@/server/mcp_upstreams/tool_result';
import type {
	CallToolParams,
	EnabledTool,
	GetPromptParams,
	McpUpstreamBackend,
	ReadResourceParams,
} from '@/server/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { type ToolCallResult, toolErrorResult } from '@/shared/mcp_results';

type CreateMcpUpstreamOperationsParams = {
	getEnabledTool: (params: {
		serverName: string;
		toolName: string;
	}) => EnabledTool | undefined;
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
			-32603,
		);
	}
};

const createMcpUpstreamOperations = (
	params: CreateMcpUpstreamOperationsParams,
) => {
	const { getEnabledTool, getBackend, trafficStore, waitForRateLimit } = params;
	const normalizeToolResult = createToolResultNormalizer();

	const callTool = async (
		callParams: CallToolParams,
	): Promise<ToolCallResult> => {
		const { serverName, toolName, args } = callParams;
		callParams.signal?.throwIfAborted();
		const server = getBackend(serverName);
		const client = server?.client;
		if (!server?.serverConfig.enabled)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is unknown or disabled`,
				-32602,
			);
		if (!client)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is not available`,
				-32603,
			);
		const enabled = getEnabledTool({
			serverName,
			toolName,
		});
		if (!enabled) {
			throw new BackendRpcError(
				`Tool "${toolName}" is unknown or disabled on MCP upstream "${serverName}"`,
				-32602,
			);
		}

		// Catalog refresh compiled the schema once. Both dashboard and MCP calls
		// validate their arguments here exactly once, before any backend work.
		const { tool, inputValidator } = enabled;
		if (!inputValidator || 'issue' in inputValidator) {
			throw new BackendRpcError(
				`Tool "${toolName}" input schema is unusable: ${inputValidator && 'issue' in inputValidator ? inputValidator.issue.detail : 'No validated catalog schema'}`,
				-32603,
			);
		}
		const inputIssue = inputValidator.validate(args);
		if (inputIssue) {
			if (inputIssue.reason !== 'schema_mismatch')
				throw new BackendRpcError(
					`Input validation unavailable: ${inputIssue.detail}`,
					-32603,
				);
			const message = `Invalid arguments for tool "${toolName}": ${inputIssue.detail}`;
			// June lists invalid arguments as protocol errors. November and modern
			// MCP report input validation failures as actionable tool errors.
			if (callParams.clientProtocolVersion === '2025-06-18')
				throw new BackendRpcError(message, -32602);
			return toolErrorResult(message);
		}
		await waitForRateLimit(server, callParams.signal);
		callParams.signal?.throwIfAborted();
		return wrapBackendFailure(serverName, callParams.signal, async () => {
			const result = await runLoggedRequest<ToolCallResult>({
				signal: callParams.signal,
				server,
				client,
				method: `tools/call:${toolName}`,
				request: args,
				invoke: () =>
					client.callTool(
						{
							name: toolName,
							arguments: args,
							_meta: callParams.metadata,
						},
						undefined,
						{
							timeout: server.serverConfig.timeout,
							mirroredHeaders: callParams.mirroredHeaders,
							signal: callParams.signal,
						},
					),
				trafficStore,
			});
			return normalizeToolResult(result, tool.outputSchema, {
				backend: serverName,
				tool: toolName,
				protocolVersion: client.protocolVersion,
			});
		});
	};

	const getPrompt = async (
		promptParams: GetPromptParams,
	): Promise<GetPromptResult> => {
		const { serverName, promptName, args } = promptParams;
		promptParams.signal?.throwIfAborted();
		const server = getBackend(serverName);
		const client = server?.client;
		if (!server?.serverConfig.enabled)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is unknown or disabled`,
				-32602,
			);
		if (!client)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is not available`,
				-32603,
			);

		await waitForRateLimit(server, promptParams.signal);
		promptParams.signal?.throwIfAborted();
		return wrapBackendFailure(serverName, promptParams.signal, () =>
			runLoggedRequest<GetPromptResult>({
				signal: promptParams.signal,
				server,
				client,
				method: `prompts/get:${promptName}`,
				request: args,
				invoke: () =>
					client.getPrompt(
						{
							name: promptName,
							arguments: args,
							_meta: promptParams.metadata,
						},
						{
							timeout: server.serverConfig.timeout,
							mirroredHeaders: promptParams.mirroredHeaders,
							signal: promptParams.signal,
						},
					),
				trafficStore,
			}),
		);
	};

	const readResource = async (
		resourceParams: ReadResourceParams,
	): Promise<ReadResourceResult> => {
		const { serverName, uri } = resourceParams;
		resourceParams.signal?.throwIfAborted();
		const server = getBackend(serverName);
		const client = server?.client;
		if (!server?.serverConfig.enabled)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is unknown or disabled`,
				-32602,
			);
		if (!client)
			throw new BackendRpcError(
				`MCP upstream "${serverName}" is not available`,
				-32603,
			);

		await waitForRateLimit(server, resourceParams.signal);
		resourceParams.signal?.throwIfAborted();
		return wrapBackendFailure(serverName, resourceParams.signal, () =>
			runLoggedRequest<ReadResourceResult>({
				signal: resourceParams.signal,
				server,
				client,
				method: `resources/read:${uri}`,
				request: {
					uri,
				},
				invoke: () =>
					client.readResource(
						{
							uri,
							_meta: resourceParams.metadata,
						},
						{
							timeout: server.serverConfig.timeout,
							mirroredHeaders: resourceParams.mirroredHeaders,
							signal: resourceParams.signal,
						},
					),
				trafficStore,
			}),
		);
	};

	return {
		callTool,
		getPrompt,
		readResource,
	};
};

export { createMcpUpstreamOperations };
