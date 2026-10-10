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
	| 'ontransporterror'
	| 'lastSuccessfulRequestAt'
	| 'protocolVersion'
>;

import type {
	GetPromptResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import type { McpConfig, McpServerConfig } from '@/config/schema';
import type { TrafficStore } from '@/server/traffic_store';
import type { ProtocolVersion } from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';

type CreateMcpUpstreamManagerParams = {
	config: McpConfig;
	trafficStore?: TrafficStore;
};

type ServerCapabilitiesInfo = ReturnType<Client['getServerCapabilities']>;
type ImplementationInfo = ReturnType<Client['getServerVersion']>;

type CallToolParams = {
	serverName: string;
	toolName: string;
	args: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	clientProtocolVersion?: ProtocolVersion;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type GetPromptParams = {
	serverName: string;
	promptName: string;
	args: Record<string, string>;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
};

type ReadResourceParams = {
	serverName: string;
	uri: string;
	metadata?: Record<string, unknown>;
	mirroredHeaders?: Record<string, string>;
	signal?: AbortSignal;
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

type McpUpstreamTools = {
	tools: Tool[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};
type McpUpstreamPrompts = {
	prompts: Prompt[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};
type McpUpstreamResources = {
	resources: Resource[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};
type McpUpstreamToolsMap = Map<string, McpUpstreamTools>;
type McpUpstreamPromptsMap = Map<string, McpUpstreamPrompts>;
type McpUpstreamResourcesMap = Map<string, McpUpstreamResources>;

type PendingAttempt<T> = {
	epoch: number;
	promise: Promise<T>;
};

// Everything the gateway tracks for one configured backend. Async work started
// for an older epoch (before a toggle or disconnect) must not change it.
type McpUpstreamBackend = McpUpstreamServer & {
	epoch: number;
	client?: Client;
	connectingClient?: ProtocolClient;
	connectionAttempt?: PendingAttempt<boolean>;
	protocolVersion?: ProtocolVersion;
	status?: McpUpstreamStatus;
	// Either error stops reconnects until the operator acts.
	configError: boolean;
	protocolError: boolean;
	reconnect?: PendingAttempt<void>;
	reconnectTimer?: Timer;
	reconnectAttempts: number;
	healthCheckReady: boolean;
	healthCheckFailures: number;
	lastRequestTime: number;
	tools?: McpUpstreamTools;
	prompts?: McpUpstreamPrompts;
	resources?: McpUpstreamResources;
	catalogExpiresAt: number;
	catalogRefresh?: Promise<void>;
};

type McpUpstreamManager = {
	refreshStaleCatalogs?: () => Promise<void>;
	refreshCatalogs: (params?: { serverName?: string }) => Promise<void>;
	initialize: () => Promise<void>;
	disconnect: () => Promise<void>;
	listAllTools: () => McpUpstreamToolsMap;
	listEnabledTools: () => McpUpstreamToolsMap;
	listAllPrompts: () => McpUpstreamPromptsMap;
	listAllResources: () => McpUpstreamResourcesMap;
	getEnabledTools: (params: { serverName: string }) => string[];
	toggleBackend: (params: ToggleBackendParams) => Promise<void>;
	toggleTool: (params: ToggleToolParams) => Promise<string[]>;
	callTool: (params: CallToolParams) => Promise<ToolCallResult>;
	getPrompt: (params: GetPromptParams) => Promise<GetPromptResult>;
	readResource: (params: ReadResourceParams) => Promise<ReadResourceResult>;
	getStatuses: () => McpUpstreamStatus[];
};

export type {
	CallToolParams,
	Client,
	CreateMcpUpstreamManagerParams,
	GetPromptParams,
	McpUpstreamBackend,
	McpUpstreamErrorState,
	McpUpstreamManager,
	McpUpstreamPrompts,
	McpUpstreamPromptsMap,
	McpUpstreamResources,
	McpUpstreamResourcesMap,
	McpUpstreamServer,
	McpUpstreamStatus,
	McpUpstreamTools,
	McpUpstreamToolsMap,
	OnValidationError,
	ReadResourceParams,
	ToggleBackendParams,
	ToggleToolParams,
};
