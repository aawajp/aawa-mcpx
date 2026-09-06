import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types';

import {
	namespacePrompt,
	namespaceResource,
	namespaceTool,
	type ParsePrefixResult,
	parsePrefix,
	parseResourceUri,
} from '@/gateway/mcp_namespaces';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import { toolErrorResult } from '@/shared/mcp_results';

type CreateHandlersParams = {
	mcpUpstreamManager: McpUpstreamManager;
};

type CallToolHandlerParams = {
	name: string;
	args: Record<string, unknown>;
};

type GetPromptHandlerParams = {
	name: string;
	args: Record<string, unknown>;
};

type ReadResourceHandlerParams = {
	uri: string;
};

const createHandlers = (params: CreateHandlersParams) => {
	const { mcpUpstreamManager } = params;

	const listTools = (): ListToolsResult => {
		const tools: ListToolsResult['tools'] = [];
		const allTools = mcpUpstreamManager.listEnabledTools();

		for (const [serverName, serverToolsResult] of allTools) {
			for (const tool of serverToolsResult.tools) {
				tools.push(
					namespaceTool({
						serverName,
						tool,
					}),
				);
			}
		}

		return {
			tools,
		};
	};

	const listPrompts = (): ListPromptsResult => {
		const prompts: ListPromptsResult['prompts'] = [];
		const allPrompts = mcpUpstreamManager.listAllPrompts();

		for (const [serverName, serverPromptsResult] of allPrompts) {
			for (const prompt of serverPromptsResult.prompts) {
				prompts.push(
					namespacePrompt({
						serverName,
						prompt,
					}),
				);
			}
		}

		return {
			prompts,
		};
	};

	const listResources = (): ListResourcesResult => {
		const resources: ListResourcesResult['resources'] = [];
		const allResources = mcpUpstreamManager.listAllResources();

		for (const [serverName, serverResourcesResult] of allResources) {
			for (const resource of serverResourcesResult.resources) {
				resources.push(
					namespaceResource({
						serverName,
						resource,
					}),
				);
			}
		}

		return {
			resources,
		};
	};

	const callTool = async (
		request: CallToolHandlerParams,
	): Promise<CallToolResult> => {
		const { name, args } = request;

		let parsed: ParsePrefixResult | null = null;
		try {
			parsed = parsePrefix(name);
		} catch (err) {
			return toolErrorResult(errorMessage(err));
		}

		if (!parsed) {
			return toolErrorResult('Failed to parse tool name');
		}

		try {
			return await mcpUpstreamManager.callTool({
				serverName: parsed.serverName,
				toolName: parsed.originalName,
				args,
			});
		} catch (err) {
			logger.error(`Tool call failed for "${name}": ${errorMessage(err)}`);
			if (err instanceof BackendRpcError) throw err;
			return toolErrorResult(errorMessage(err));
		}
	};

	const getPrompt = async (
		request: GetPromptHandlerParams,
	): Promise<GetPromptResult> => {
		const { name, args } = request;
		const parsed = parsePrefix(name);

		return await mcpUpstreamManager.getPrompt({
			serverName: parsed.serverName,
			promptName: parsed.originalName,
			args: args as Record<string, string>,
		});
	};

	const readResource = async (
		request: ReadResourceHandlerParams,
	): Promise<ReadResourceResult> => {
		const { uri } = request;
		const parsed = parseResourceUri(uri);

		return await mcpUpstreamManager.readResource({
			serverName: parsed.serverName,
			uri: parsed.originalUri,
		});
	};

	return {
		listTools,
		listPrompts,
		listResources,
		callTool,
		getPrompt,
		readResource,
	};
};

export { createHandlers };
