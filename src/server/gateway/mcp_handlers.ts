import type {
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	ReadResourceResult,
} from '@modelcontextprotocol/client';

import {
	namespacePrompt,
	namespaceResource,
	namespaceResourceTemplate,
	namespaceTool,
} from '@/server/gateway/mcp_namespaces';
import { logger } from '@/server/logger';
import { BackendRpcError } from '@/server/mcp_upstreams/protocol_client';
import type {
	EnabledTool,
	McpUpstreamManager,
} from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';
import {
	addResourcePrefix,
	parsePrefix,
	parseResourceUri,
} from '@/shared/mcp_namespaces';
import {
	type ProtocolVersion,
	RPC_ERROR,
	usesRequestMetadata,
} from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';

type CreateHandlersParams = {
	mcpUpstreamManager: McpUpstreamManager;
};

type CallToolHandlerParams = {
	tool: EnabledTool;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	clientProtocolVersion?: ProtocolVersion;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type GetPromptHandlerParams = {
	name: string;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type ReadResourceHandlerParams = {
	uri: string;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

// A malformed name or URI is the client's error.
const parseOrInvalid = <T>(parse: () => T): T => {
	try {
		return parse();
	} catch (error) {
		throw new BackendRpcError(errorMessage(error), RPC_ERROR.InvalidParams);
	}
};

// Routes a resource reference back to the backend that returned it.
const prefixResource = <T extends { uri: string }>(
	serverName: string,
	resource: T,
): T => ({
	...resource,
	uri: addResourcePrefix({
		serverName,
		uri: resource.uri,
	}),
});

const createHandlers = (params: CreateHandlersParams) => {
	const { mcpUpstreamManager } = params;

	// Since MCP 2026-07-28, clients cannot call a tool with invalid header
	// annotations.
	const listTools = (
		clientProtocolVersion?: ProtocolVersion,
	): ListToolsResult => ({
		tools: mcpUpstreamManager
			.listEnabledTools()
			.filter(
				({ headerParameters }) =>
					!usesRequestMetadata(clientProtocolVersion) ||
					!(headerParameters instanceof Error),
			)
			.map(({ serverName, tool }) =>
				namespaceTool({
					serverName,
					tool,
				}),
			),
	});

	// The enabled tool behind a namespaced name; a client error otherwise.
	const resolveTool = (name: string): EnabledTool => {
		const parsed = parseOrInvalid(() => parsePrefix(name));
		return mcpUpstreamManager.getEnabledTool({
			serverName: parsed.serverName,
			toolName: parsed.originalName,
		});
	};

	const listPrompts = (): ListPromptsResult => {
		const prompts: ListPromptsResult['prompts'] = [];
		const allPrompts = mcpUpstreamManager.listEnabledPrompts();

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
		const allResources = mcpUpstreamManager.listEnabledResources();

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

	const listResourceTemplates = (): ListResourceTemplatesResult => {
		const resourceTemplates: ListResourceTemplatesResult['resourceTemplates'] =
			[];
		for (const [
			serverName,
			result,
		] of mcpUpstreamManager.listEnabledResourceTemplates())
			for (const resourceTemplate of result.resourceTemplates)
				resourceTemplates.push(
					namespaceResourceTemplate({
						serverName,
						resourceTemplate,
					}),
				);
		return {
			resourceTemplates,
		};
	};

	const callTool = async (
		request: CallToolHandlerParams,
	): Promise<ToolCallResult> => {
		const { tool, args } = request;
		const { serverName } = tool;
		try {
			const result = await mcpUpstreamManager.callTool({
				tool,
				args,
				metadata: request.metadata,
				clientProtocolVersion: request.clientProtocolVersion,
				mirroredHeaders: request.mirroredHeaders,
				signal: request.signal,
			});
			// Only protocol resource references need routing. Text and structured
			// output are backend data and must not be searched or rewritten for URIs.
			return {
				...result,
				content: result.content.map((block) => {
					if (block.type === 'resource_link')
						return prefixResource(serverName, block);
					if (block.type === 'resource')
						return {
							...block,
							resource: prefixResource(serverName, block.resource),
						};
					return block;
				}),
			};
		} catch (err) {
			if (request.signal?.aborted || err instanceof BackendRpcError) throw err;
			logger.error(
				JSON.stringify({
					message: 'Gateway tool dispatch failed',
					context: {
						backend: serverName,
						tool: tool.tool.name,
					},
					error: errorMessage(err),
				}),
			);
			// Execution errors arrive as tool results. Unexpected dispatcher failures
			// are server errors, not actionable tool feedback.
			throw new BackendRpcError(
				'Internal server error',
				RPC_ERROR.InternalError,
			);
		}
	};

	const getPrompt = async (
		request: GetPromptHandlerParams,
	): Promise<GetPromptResult> => {
		const { name, args } = request;
		const parsed = parseOrInvalid(() => parsePrefix(name));

		const result = await mcpUpstreamManager.getPrompt({
			serverName: parsed.serverName,
			promptName: parsed.originalName,
			args: args as Record<string, string>,
			metadata: request.metadata,
			mirroredHeaders: request.mirroredHeaders,
			signal: request.signal,
		});
		return {
			...result,
			messages: result.messages.map((message) => {
				const block = message.content;
				if (block.type !== 'resource') return message;
				return {
					...message,
					content: {
						...block,
						resource: prefixResource(parsed.serverName, block.resource),
					},
				};
			}),
		};
	};

	const readResource = async (
		request: ReadResourceHandlerParams,
	): Promise<ReadResourceResult> => {
		const { uri } = request;
		const parsed = parseOrInvalid(() => parseResourceUri(uri));

		// Links and template instances need not appear in resources/list. Route
		// by namespace, leaving resource existence checks to the owning backend.
		const result = await mcpUpstreamManager.readResource({
			serverName: parsed.serverName,
			uri: parsed.originalUri,
			metadata: request.metadata,
			mirroredHeaders: request.mirroredHeaders,
			signal: request.signal,
		});
		return {
			...result,
			contents: result.contents.map((content) =>
				prefixResource(parsed.serverName, content),
			),
		};
	};

	return {
		listTools,
		listPrompts,
		listResources,
		listResourceTemplates,
		resolveTool,
		callTool,
		getPrompt,
		readResource,
	};
};

export { createHandlers };
