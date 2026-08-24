import type {
	CallToolResult,
	GetPromptResult,
	ReadResourceResult,
} from '@modelcontextprotocol/sdk/types';
import { type } from 'arktype';

import type {
	CallToolParams,
	GetPromptParams,
	McpUpstreamClientsMap,
	McpUpstreamServer,
	ReadResourceParams,
} from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import type { TrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';
import {
	callToolResultType,
	getPromptResultType,
	readResourceResultType,
} from '@/shared/mcp_schemas';

type OnValidationError = (params: {
	server: McpUpstreamServer;
	method: string;
	error: type.errors;
	request?: unknown;
}) => void;

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
			return {
				content: [
					{
						type: 'text',
						text: `MCP upstream "${serverName}" is not available`,
					},
				],
				isError: true,
			};
		}
		const enabledTools = getEnabledTools({
			serverName,
		});
		if (!enabledTools.includes(toolName)) {
			return {
				content: [
					{
						type: 'text',
						text: `Tool "${toolName}" is disabled on MCP upstream "${serverName}"`,
					},
				],
				isError: true,
			};
		}

		await waitForRateLimit(server);
		try {
			const result = await client.callTool(
				{
					name: toolName,
					arguments: args,
				},
				undefined,
				{
					timeout: server.serverConfig.timeout,
				},
			);
			const parsed = callToolResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server,
					method: `tools/call:${toolName}`,
					error: parsed,
					request: {
						name: toolName,
					},
				});
			}
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `tools/call:${toolName}`,
				request: args,
				response: result,
			});
			return result as CallToolResult;
		} catch (err) {
			logger.error(
				`Failed to call tool "${toolName}" on "${serverName}": ${errorMessage(err)}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `tools/call:${toolName}`,
				request: args,
				response: {
					error: errorMessage(err),
				},
			});
			return {
				content: [
					{
						type: 'text',
						text: `Server "${serverName}" error: ${errorMessage(err)}`,
					},
				],
				isError: true,
			};
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
		try {
			const result = await client.getPrompt(
				{
					name: promptName,
					arguments: args,
				},
				{
					timeout: server.serverConfig.timeout,
				},
			);
			const parsed = getPromptResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server,
					method: `prompts/get:${promptName}`,
					error: parsed,
					request: {
						name: promptName,
					},
				});
			}
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `prompts/get:${promptName}`,
				request: args,
				response: result,
			});
			return result;
		} catch (err) {
			logger.error(
				`Failed to get prompt "${promptName}" from "${serverName}": ${errorMessage(err)}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `prompts/get:${promptName}`,
				request: args,
				response: {
					error: errorMessage(err),
				},
			});
			throw new Error(`Server "${serverName}" error: ${errorMessage(err)}`);
		}
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
		try {
			const result = await client.readResource(
				{
					uri,
				},
				{
					timeout: server.serverConfig.timeout,
				},
			);
			const parsed = readResourceResultType(result);
			if (parsed instanceof type.errors) {
				onValidationError({
					server,
					method: `resources/read:${uri}`,
					error: parsed,
					request: {
						uri,
					},
				});
			}
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `resources/read:${uri}`,
				request: {
					uri,
				},
				response: result,
			});
			return result;
		} catch (err) {
			logger.error(
				`Failed to read resource "${uri}" from "${serverName}": ${errorMessage(err)}`,
			);
			trafficStore?.logBackendTraffic({
				backend: serverName,
				method: `resources/read:${uri}`,
				request: {
					uri,
				},
				response: {
					error: errorMessage(err),
				},
			});
			throw new Error(`Server "${serverName}" error: ${errorMessage(err)}`);
		}
	};

	return {
		callTool,
		getPrompt,
		readResource,
	};
};

export { createMcpUpstreamOperations };
