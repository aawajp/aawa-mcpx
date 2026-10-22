import type {
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	ReadResourceResult,
} from '@modelcontextprotocol/client';

import type { Access } from '@/server/db/access';
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
	access?: Access;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type ReadResourceHandlerParams = {
	uri: string;
	access?: Access;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

// An enabled tool or backend the user has no permission for.
class AccessDeniedError extends Error {}

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
		access?: Access,
	): ListToolsResult => ({
		tools: mcpUpstreamManager
			.listEnabledTools()
			.filter(
				({ headerParameters, serverName, tool }) =>
					(!usesRequestMetadata(clientProtocolVersion) ||
						!(headerParameters instanceof Error)) &&
					(!access || access.allowsTool(serverName, tool.name)),
			)
			.map(({ serverName, tool }) =>
				namespaceTool({
					serverName,
					tool,
				}),
			),
	});

	// The enabled tool behind a namespaced name; a client error otherwise, and
	// a refusal when the user has no permission for it.
	const resolveTool = (name: string, access?: Access): EnabledTool => {
		const parsed = parseOrInvalid(() => parsePrefix(name));
		const tool = mcpUpstreamManager.getEnabledTool({
			serverName: parsed.serverName,
			toolName: parsed.originalName,
		});
		if (access && !access.allowsTool(tool.serverName, tool.tool.name))
			throw new AccessDeniedError(`Tool "${name}" is not permitted`);
		return tool;
	};

	// Unknown or disabled backends keep their usual errors; only an enabled
	// backend without permission is refused here.
	const checkBackend = (serverName: string, access?: Access): void => {
		if (
			access &&
			!access.allowsBackend(serverName) &&
			mcpUpstreamManager
				.getStatuses()
				.some((status) => status.serverName === serverName && status.enabled)
		)
			throw new AccessDeniedError(`Backend "${serverName}" is not permitted`);
	};

	const allowedBackends = <T>(
		entries: Iterable<[string, T]>,
		access?: Access,
	): [string, T][] =>
		[...entries].filter(
			([serverName]) => !access || access.allowsBackend(serverName),
		);

	const listPrompts = (access?: Access): ListPromptsResult => {
		const prompts: ListPromptsResult['prompts'] = [];
		const allPrompts = allowedBackends(
			mcpUpstreamManager.listEnabledPrompts(),
			access,
		);

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

	const listResources = (access?: Access): ListResourcesResult => {
		const resources: ListResourcesResult['resources'] = [];
		const allResources = allowedBackends(
			mcpUpstreamManager.listEnabledResources(),
			access,
		);

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

	const listResourceTemplates = (
		access?: Access,
	): ListResourceTemplatesResult => {
		const resourceTemplates: ListResourceTemplatesResult['resourceTemplates'] =
			[];
		for (const [serverName, result] of allowedBackends(
			mcpUpstreamManager.listEnabledResourceTemplates(),
			access,
		))
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
		checkBackend(parsed.serverName, request.access);

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
		checkBackend(parsed.serverName, request.access);

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

export { AccessDeniedError, createHandlers };
