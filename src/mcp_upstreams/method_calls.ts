import type {
	GetPromptResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types';

import type { CompiledSchema } from '@/mcp_upstreams/json_schema';
import { runLoggedRequest } from '@/mcp_upstreams/logged_request';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import { createToolResultNormalizer } from '@/mcp_upstreams/tool_result';
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
import { type ToolCallResult, toolErrorResult } from '@/shared/mcp_results';
import {
	callToolResultType,
	getPromptResultType,
	readResourceResultType,
} from '@/shared/mcp_schemas';

type CreateMcpUpstreamOperationsParams = {
	clients: McpUpstreamClientsMap;
	getEnabledTools: (params: { serverName: string }) => string[];
	getOutputSchema: (params: {
		serverName: string;
		toolName: string;
	}) => unknown;
	getInputValidator: (params: {
		serverName: string;
		toolName: string;
	}) => CompiledSchema | undefined;
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
	const normalizeToolResult = createToolResultNormalizer();

	const callTool = async (
		callParams: CallToolParams,
	): Promise<ToolCallResult> => {
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

		// Catalog refresh compiled the schema once. Both dashboard and MCP calls
		// validate their arguments here exactly once, before any backend work.
		const inputValidator = params.getInputValidator({
			serverName,
			toolName,
		});
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
		const outputSchema = params.getOutputSchema({
			serverName,
			toolName,
		});
		await waitForRateLimit(server);
		try {
			const result = await runLoggedRequest<ToolCallResult>({
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
			return normalizeToolResult(result, outputSchema, {
				backend: serverName,
				tool: toolName,
				protocolVersion: client.protocolVersion,
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
