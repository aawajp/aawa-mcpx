import type { type } from 'arktype';

import type { ProtocolClient } from '@/mcp_upstreams/protocol_client';

type OnValidationError = (params: {
	server: McpUpstreamServer;
	method: string;
	error: type.errors;
	request?: unknown;
}) => void;

type Client = Pick<
	ProtocolClient,
	| 'getServerCapabilities'
	| 'getServerVersion'
	| 'getInstructions'
	| 'ping'
	| 'listTools'
	| 'listPrompts'
	| 'listResources'
	| 'callTool'
	| 'getPrompt'
	| 'readResource'
	| 'close'
	| 'onerror'
	| 'protocolVersion'
>;

import type {
	CallToolResult,
	GetPromptResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import type { McpConfig, McpServerConfig } from '@/config/schema';
import type { TrafficStore } from '@/server/traffic_store';

type CreateMcpUpstreamManagerParams = {
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

type ToggleToolParams = {
	serverName: string;
	toolName: string;
	enabled: boolean;
};

type ToggleBackendParams = {
	serverName: string;
	enabled: boolean;
};

type McpUpstreamErrorState = 'runtime' | 'configuration' | 'protocol';

type McpUpstreamStatusBase = {
	serverName: string;
	protocolVersion?: string;
	enabled: boolean;
	enabledTools: string[];
	connected: boolean;
	error?: string;
	errorState?: McpUpstreamErrorState;
	actionRequired?: boolean;
	implementation?: ImplementationInfo;
	capabilities?: ServerCapabilitiesInfo;
	instructions?: string;
};

type McpUpstreamStatus = McpUpstreamStatusBase &
	(
		| {
				type: 'http';
				url: string;
		  }
		| {
				type: 'stdio';
				command: string;
		  }
	);

type McpUpstreamServer = {
	serverName: string;
	serverConfig: McpServerConfig;
};

type McpUpstreamToolsMap = Map<
	string,
	{
		tools: Tool[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type McpUpstreamPromptsMap = Map<
	string,
	{
		prompts: Prompt[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type McpUpstreamResourcesMap = Map<
	string,
	{
		resources: Resource[];
		nextCursor?: string;
		_meta?: Record<string, unknown>;
	}
>;
type McpUpstreamClientsMap = Map<string, Client>;

type McpUpstreamRequestQueue = {
	pending: Array<{
		resolve: (value: unknown) => void;
		reject: (reason?: unknown) => void;
		request: () => Promise<unknown>;
	}>;
	isProcessing: boolean;
	lastRequestTime: number;
};

type McpUpstreamManager = {
	refreshStaleCatalogs?: () => Promise<void>;
	initialize: () => Promise<void>;
	getClient: (params: GetClientParams) => Client | undefined;
	getAllClients: () => McpUpstreamClientsMap;
	disconnect: () => Promise<void>;
	listAllTools: () => McpUpstreamToolsMap;
	listEnabledTools: () => McpUpstreamToolsMap;
	listAllPrompts: () => McpUpstreamPromptsMap;
	listAllResources: () => McpUpstreamResourcesMap;
	getEnabledTools: (params: { serverName: string }) => string[];
	toggleBackend: (params: ToggleBackendParams) => Promise<void>;
	toggleTool: (params: ToggleToolParams) => Promise<string[]>;
	callTool: (params: CallToolParams) => Promise<CallToolResult>;
	getPrompt: (params: GetPromptParams) => Promise<GetPromptResult>;
	readResource: (params: ReadResourceParams) => Promise<ReadResourceResult>;
	getStatuses: () => McpUpstreamStatus[];
};

export type {
	CallToolParams,
	Client,
	CreateMcpUpstreamManagerParams,
	GetClientParams,
	GetPromptParams,
	McpUpstreamClientsMap,
	McpUpstreamErrorState,
	McpUpstreamManager,
	McpUpstreamPromptsMap,
	McpUpstreamRequestQueue,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamStatus,
	McpUpstreamToolsMap,
	OnValidationError,
	ReadResourceParams,
	ToggleBackendParams,
	ToggleToolParams,
};
