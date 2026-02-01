import type { Client } from '@modelcontextprotocol/sdk/client';
import type {
	CallToolResult,
	GetPromptResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool,
} from '@modelcontextprotocol/sdk/types.d.ts';

import type { McpConfig } from '@/config/types';
import type { TrafficStore } from '@/utils/trafficStore';

type CreateBackendManagerParams = {
	config: McpConfig;
	trafficStore?: TrafficStore;
};

type ServerCapabilitiesInfo = ReturnType<Client['getServerCapabilities']>;
type ImplementationInfo = ReturnType<Client['getServerVersion']>;

type GetClientParams = {
	serverName: string;
};

type CallToolParams = {
	serverName: string;
	toolName: string;
	args: Record<string, unknown>;
};

type GetPromptParams = {
	serverName: string;
	promptName: string;
	args: Record<string, string>;
};

type ReadResourceParams = {
	serverName: string;
	uri: string;
};

type BackendStatus = {
	serverName: string;
	url: string;
	connected: boolean;
	error?: string;
	implementation?: ImplementationInfo;
	capabilities?: ServerCapabilitiesInfo;
	instructions?: string;
};

type ToolsMap = Map<
	string,
	{
		tools: Tool[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type PromptsMap = Map<
	string,
	{
		prompts: Prompt[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type ResourcesMap = Map<
	string,
	{
		resources: Resource[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type ClientsMap = Map<string, Client>;

type RequestQueue = {
	pending: Array<{
		resolve: (value: unknown) => void;
		reject: (reason?: unknown) => void;
		request: () => Promise<unknown>;
	}>;
	isProcessing: boolean;
	lastRequestTime: number;
};

type BackendManager = {
	initialize: () => Promise<void>;
	getClient: (params: GetClientParams) => Client | undefined;
	getAllClients: () => ClientsMap;
	disconnect: () => Promise<void>;
	listAllTools: () => ToolsMap;
	listAllPrompts: () => PromptsMap;
	listAllResources: () => ResourcesMap;
	callTool: (params: CallToolParams) => Promise<CallToolResult>;
	getPrompt: (params: GetPromptParams) => Promise<GetPromptResult>;
	readResource: (params: ReadResourceParams) => Promise<ReadResourceResult>;
	getStatuses: () => BackendStatus[];
};

export type {
	BackendStatus,
	BackendManager,
	CallToolParams,
	ClientsMap,
	CreateBackendManagerParams,
	GetClientParams,
	GetPromptParams,
	PromptsMap,
	ReadResourceParams,
	RequestQueue,
	ResourcesMap,
	ToolsMap,
};
