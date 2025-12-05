import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { BackendManager } from '@/backend/types';
import {
	namespacePrompt,
	namespaceResource,
	namespaceTool,
	type ParsePrefixResult,
	parsePrefix,
	parseResourceUri,
} from '@/gateway/namespace';
import { logger } from '@/utils/logger';

type CreateHandlersParams = {
	backendManager: BackendManager;
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
	const { backendManager } = params;

	// Cached namespaced results - tools/prompts/resources only change on server restart
	let cachedTools: ListToolsResult | null = null;
	let cachedPrompts: ListPromptsResult | null = null;
	let cachedResources: ListResourcesResult | null = null;

	const buildToolsCache = (): ListToolsResult => {
		const tools: ListToolsResult['tools'] = [];
		const allTools = backendManager.listAllTools();

		for (const [serverName, serverToolsResult] of allTools) {
			for (const tool of serverToolsResult.tools) {
				tools.push(namespaceTool({ serverName, tool }));
			}
		}

		return { tools };
	};

	const buildPromptsCache = (): ListPromptsResult => {
		const prompts: ListPromptsResult['prompts'] = [];
		const allPrompts = backendManager.listAllPrompts();

		for (const [serverName, serverPromptsResult] of allPrompts) {
			for (const prompt of serverPromptsResult.prompts) {
				prompts.push(namespacePrompt({ serverName, prompt }));
			}
		}

		return { prompts };
	};

	const buildResourcesCache = (): ListResourcesResult => {
		const resources: ListResourcesResult['resources'] = [];
		const allResources = backendManager.listAllResources();

		for (const [serverName, serverResourcesResult] of allResources) {
			for (const resource of serverResourcesResult.resources) {
				resources.push(namespaceResource({ serverName, resource }));
			}
		}

		return { resources };
	};

	const listTools = (): ListToolsResult => {
		if (!cachedTools) {
			cachedTools = buildToolsCache();
		}
		return cachedTools;
	};

	const listPrompts = (): ListPromptsResult => {
		if (!cachedPrompts) {
			cachedPrompts = buildPromptsCache();
		}
		return cachedPrompts;
	};

	const listResources = (): ListResourcesResult => {
		if (!cachedResources) {
			cachedResources = buildResourcesCache();
		}
		return cachedResources;
	};

	const callTool = async (
		request: CallToolHandlerParams,
	): Promise<CallToolResult> => {
		const { name, args } = request;

		let parsed: ParsePrefixResult | null = null;
		try {
			parsed = parsePrefix(name);
		} catch (error) {
			return {
				content: [{ type: 'text', text: (error as Error).message }],
				isError: true,
			};
		}

		if (!parsed) {
			return {
				content: [{ type: 'text', text: 'Failed to parse tool name' }],
				isError: true,
			};
		}

		try {
			return await backendManager.callTool({
				serverName: parsed.serverName,
				toolName: parsed.originalName,
				args,
			});
		} catch (error) {
			logger.error(
				`Tool call failed for "${name}": ${(error as Error).message}`,
			);
			return {
				content: [{ type: 'text', text: (error as Error).message }],
				isError: true,
			};
		}
	};

	const getPrompt = async (
		request: GetPromptHandlerParams,
	): Promise<GetPromptResult> => {
		const { name, args } = request;
		const parsed = parsePrefix(name);

		return await backendManager.getPrompt({
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

		return await backendManager.readResource({
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
