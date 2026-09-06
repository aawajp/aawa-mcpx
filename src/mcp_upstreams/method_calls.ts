import type {
	CallToolResult,
	GetPromptResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types';

import { runLoggedRequest } from '@/mcp_upstreams/logged_request';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import type {
	CallToolParams,
	GetPromptParams,
	McpUpstreamClientsMap,
	McpUpstreamServer,
	OnValidationError,
	ReadResourceParams,
} from '@/mcp_upstreams/types';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import { toolErrorResult } from '@/shared/mcp_results';
import {
	callToolResultType,
	getPromptResultType,
	readResourceResultType,
} from '@/shared/mcp_schemas';

type CreateMcpUpstreamOperationsParams = {
	clients: McpUpstreamClientsMap;
	getEnabledTools: (params: { serverName: string }) => string[];
	getServer: (serverName: string) => McpUpstreamServer | undefined;
	onValidationError: OnValidationError;
	trafficStore?: TrafficStore;
	waitForRateLimit: (server: McpUpstreamServer) => Promise<void>;
};

const createMcpUpstreamOperations = (
	params: CreateMcpUpstreamOperationsParams,
) => {
	const {
		clients,
		getEnabledTools,
		getServer,
		onValidationError,
		trafficStore,
		waitForRateLimit,
	} = params;

	const callTool = async (
		callParams: CallToolParams,
	): Promise<CallToolResult> => {
		const { serverName, toolName, args } = callParams;
		const server = getServer(serverName);
		const client = clients.get(serverName);
		if (!server || !client) {
			return toolErrorResult(`MCP upstream "${serverName}" is not available`);
		}
		const enabledTools = getEnabledTools({
			serverName,
		});
		if (!enabledTools.includes(toolName)) {
			return toolErrorResult(
				`Tool "${toolName}" is disabled on MCP upstream "${serverName}"`,
			);
		}

		await waitForRateLimit(server);
		try {
			return await runLoggedRequest<CallToolResult>({
				server,
				client,
				method: `tools/call:${toolName}`,
				request: args,
				validationRequest: {
					name: toolName,
				},
				invoke: () =>
					client.callTool(
						{
							name: toolName,
							arguments: args,
						},
						undefined,
						{
							timeout: server.serverConfig.timeout,
						},
					),
				validate: callToolResultType,
				onValidationError,
				trafficStore,
			});
		} catch (error) {
			if (error instanceof BackendRpcError) throw error;
			return toolErrorResult(
				`Server "${serverName}" error: ${errorMessage(error)}`,
			);
		}
	};

	const getPrompt = async (
		promptParams: GetPromptParams,
	): Promise<GetPromptResult> => {
		const { serverName, promptName, args } = promptParams;
		const server = getServer(serverName);
		const client = clients.get(serverName);
		if (!server || !client) {
			throw new Error(`MCP upstream "${serverName}" is not available`);
		}

		await waitForRateLimit(server);
		return runLoggedRequest<GetPromptResult>({
			server,
			client,
			method: `prompts/get:${promptName}`,
			request: args,
			validationRequest: {
				name: promptName,
			},
			invoke: () =>
				client.getPrompt(
					{
						name: promptName,
						arguments: args,
					},
					{
						timeout: server.serverConfig.timeout,
					},
				),
			validate: getPromptResultType,
			onValidationError,
			trafficStore,
		});
	};

	const readResource = async (
		resourceParams: ReadResourceParams,
	): Promise<ReadResourceResult> => {
		const { serverName, uri } = resourceParams;
		const server = getServer(serverName);
		const client = clients.get(serverName);
		if (!server || !client) {
			throw new Error(`MCP upstream "${serverName}" is not available`);
		}

		await waitForRateLimit(server);
		return runLoggedRequest<ReadResourceResult>({
			server,
			client,
			method: `resources/read:${uri}`,
			request: {
				uri,
			},
			validationRequest: {
				uri,
			},
			invoke: () =>
				client.readResource(
					{
						uri,
					},
					{
						timeout: server.serverConfig.timeout,
					},
				),
			validate: readResourceResultType,
			onValidationError,
			trafficStore,
		});
	};

	return {
		callTool,
		getPrompt,
		readResource,
	};
};

export { createMcpUpstreamOperations };
