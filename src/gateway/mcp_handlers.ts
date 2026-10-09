import type {
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
} from '@/gateway/mcp_namespaces';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import type { McpUpstreamManager } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import {
	addResourcePrefix,
	type ParsePrefixResult,
	type ParseResourceUriResult,
	parsePrefix,
	parseResourceUri,
} from '@/shared/mcp_namespaces';
import {
	CURRENT_PROTOCOL_VERSION,
	type ProtocolVersion,
	toolHeaderParameters,
} from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';

type CreateHandlersParams = {
	mcpUpstreamManager: McpUpstreamManager;
};

type CallToolHandlerParams = {
	name: string;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	clientProtocolVersion?: ProtocolVersion;
	mirroredHeaders?: Record<string, string>;
};

type GetPromptHandlerParams = {
	name: string;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
};

type ReadResourceHandlerParams = {
	uri: string;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
};

const createHandlers = (params: CreateHandlersParams) => {
	const { mcpUpstreamManager } = params;

	const listTools = (
		clientProtocolVersion?: ProtocolVersion,
	): ListToolsResult => {
		const tools: ListToolsResult['tools'] = [];
		const allTools = mcpUpstreamManager.listEnabledTools();

		for (const [serverName, serverToolsResult] of allTools) {
			for (const tool of serverToolsResult.tools) {
				if (clientProtocolVersion === CURRENT_PROTOCOL_VERSION) {
					try {
						toolHeaderParameters(tool.inputSchema);
					} catch {
						continue;
					}
				}
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
	): Promise<ToolCallResult> => {
		const { name, args } = request;

		let parsed: ParsePrefixResult;
		try {
			parsed = parsePrefix(name);
		} catch (err) {
			throw new BackendRpcError(errorMessage(err), -32602);
		}

		try {
			if (request.clientProtocolVersion === CURRENT_PROTOCOL_VERSION) {
				const tool = mcpUpstreamManager
					.listEnabledTools()
					.get(parsed.serverName)
					?.tools.find((tool) => tool.name === parsed.originalName);
				if (tool) {
					try {
						toolHeaderParameters(tool.inputSchema);
					} catch {
						throw new BackendRpcError(
							`Tool "${name}" has invalid HTTP header annotations`,
							-32602,
						);
					}
				}
			}
			const result = await mcpUpstreamManager.callTool({
				serverName: parsed.serverName,
				toolName: parsed.originalName,
				args,
				metadata: request.metadata,
				clientProtocolVersion: request.clientProtocolVersion,
				mirroredHeaders: request.mirroredHeaders,
			});
			// Only protocol resource references need routing. Text and structured
			// output are backend data and must not be searched or rewritten for URIs.
			return {
				...result,
				content: result.content.map((block) => {
					if (block.type === 'resource_link')
						return {
							...block,
							uri: addResourcePrefix({
								serverName: parsed.serverName,
								uri: block.uri,
							}),
						};
					if (block.type === 'resource')
						return {
							...block,
							resource: {
								...block.resource,
								uri: addResourcePrefix({
									serverName: parsed.serverName,
									uri: block.resource.uri,
								}),
							},
						};
					return block;
				}),
			};
		} catch (err) {
			if (err instanceof BackendRpcError) throw err;
			logger.error(
				JSON.stringify({
					message: 'Gateway tool dispatch failed',
					context: {
						tool: name,
					},
					error: errorMessage(err),
				}),
			);
			// Execution errors arrive as tool results. Unexpected dispatcher failures
			// are server errors, not actionable tool feedback.
			throw new BackendRpcError('Internal server error', -32603);
		}
	};

	const getPrompt = async (
		request: GetPromptHandlerParams,
	): Promise<GetPromptResult> => {
		const { name, args } = request;
		let parsed: ParsePrefixResult;
		try {
			parsed = parsePrefix(name);
		} catch (error) {
			throw new BackendRpcError(errorMessage(error), -32602);
		}

		const result = await mcpUpstreamManager.getPrompt({
			serverName: parsed.serverName,
			promptName: parsed.originalName,
			args: args as Record<string, string>,
			metadata: request.metadata,
			mirroredHeaders: request.mirroredHeaders,
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
						resource: {
							...block.resource,
							uri: addResourcePrefix({
								serverName: parsed.serverName,
								uri: block.resource.uri,
							}),
						},
					},
				};
			}),
		};
	};

	const readResource = async (
		request: ReadResourceHandlerParams,
	): Promise<ReadResourceResult> => {
		const { uri } = request;
		let parsed: ParseResourceUriResult;
		try {
			parsed = parseResourceUri(uri);
		} catch (error) {
			throw new BackendRpcError(errorMessage(error), -32602);
		}

		// Links and template instances need not appear in resources/list. Route
		// by namespace, leaving resource existence checks to the owning backend.
		const result = await mcpUpstreamManager.readResource({
			serverName: parsed.serverName,
			uri: parsed.originalUri,
			metadata: request.metadata,
			mirroredHeaders: request.mirroredHeaders,
		});
		return {
			...result,
			contents: result.contents.map((content) => ({
				...content,
				uri: addResourcePrefix({
					serverName: parsed.serverName,
					uri: content.uri,
				}),
			})),
		};
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
