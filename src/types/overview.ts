import type {
	Prompt,
	Resource,
	Tool,
} from '@modelcontextprotocol/sdk/types.js';

type ListToolsWithMeta = {
	tools: Tool[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};

type ListPromptsWithMeta = {
	prompts: Prompt[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};

type ListResourcesWithMeta = {
	resources: Resource[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
};

type ImplementationInfo = {
	name?: string;
	version?: string;
	title?: string;
	description?: string;
	websiteUrl?: string;
	[key: string]: unknown;
};

type CapabilitiesInfo = Record<string, unknown> | undefined;

type BackendStatus = {
	serverName: string;
	url: string;
	connected: boolean;
	error?: string;
	implementation?: ImplementationInfo;
	capabilities?: CapabilitiesInfo;
	instructions?: string;
	tools: ListToolsWithMeta;
	prompts: ListPromptsWithMeta;
	resources: ListResourcesWithMeta;
};

type OverviewResponse = {
	protocolVersion?: string;
	aggregated: {
		tools: Tool[];
		prompts: Prompt[];
		resources: Resource[];
	};
	backends: BackendStatus[];
};

type TrafficRecord = {
	id: number;
	peer: string;
	method?: string;
	request: unknown;
	response: unknown;
	createdAt: number;
};

type TrafficPage = {
	records: TrafficRecord[];
	total: number;
};

export type {
	BackendStatus,
	CapabilitiesInfo,
	ImplementationInfo,
	ListPromptsWithMeta,
	ListResourcesWithMeta,
	ListToolsWithMeta,
	OverviewResponse,
	TrafficPage,
	TrafficRecord,
};
