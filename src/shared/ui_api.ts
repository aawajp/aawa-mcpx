import { type } from 'arktype';

import {
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
	promptType,
	resourceType,
	type toolType,
} from '@/shared/mcp_schemas';

const listToolsWithMetaType = listToolsResultType;
const listPromptsWithMetaType = listPromptsResultType;
const listResourcesWithMetaType = listResourcesResultType;

const implementationInfoType = type({
	'name?': 'string',
	'version?': 'string',
	'title?': 'string',
	'description?': 'string',
	'websiteUrl?': 'string',
	'[string]': 'unknown',
});

const capabilitiesInfoType = type('Record<string, unknown>');

const clientInfoType = type({
	name: 'string',
	'title?': 'string',
	version: 'string',
	'[string]': 'unknown',
});

const clientActivityType = type({
	client: clientInfoType,
	protocolVersion: 'string',
	firstSeen: 'number.integer',
	lastSeen: 'number.integer',
});

const clientToolType = type({
	name: 'string',
	'description?': 'string',
	enabled: 'boolean',
	inputSchema: 'unknown',
	'[string]': 'unknown',
});

const backendStatusSharedFields = {
	serverName: 'string',
	'protocolVersion?': 'string',
	enabled: 'boolean',
	enabledTools: 'string[]',
	connected: 'boolean',
	'error?': 'string',
	'errorState?': "'runtime' | 'configuration' | 'protocol'",
	'actionRequired?': 'boolean',
	'implementation?': implementationInfoType,
	'capabilities?': capabilitiesInfoType,
	'instructions?': 'string',
	tools: listToolsWithMetaType,
	prompts: listPromptsWithMetaType,
	resources: listResourcesWithMetaType,
	'[string]': 'unknown',
} as const;

const backendStatusType = type(
	{
		type: "'http'",
		url: 'string',
		...backendStatusSharedFields,
	},
	'|',
	{
		type: "'stdio'",
		command: 'string',
		...backendStatusSharedFields,
	},
);

const overviewResponseType = type({
	'protocolVersion?': 'string',
	'supportedProtocolVersions?': 'string[]',
	aggregated: {
		tools: clientToolType.array(),
		prompts: promptType.array(),
		resources: resourceType.array(),
		'[string]': 'unknown',
	},
	backends: backendStatusType.array(),
	clients: clientActivityType.array(),
	'[string]': 'unknown',
});

const trafficRecordType = type({
	'protocolVersion?': 'string',
	id: 'number.integer',
	kind: "'client' | 'backend'",
	peer: 'string',
	'method?': 'string',
	'relatedMethod?': 'string',
	eventType: "'success' | 'error' | 'validation_error'",
	isError: 'boolean',
	request: 'unknown',
	response: 'unknown',
	createdAt: 'number.integer',
	'[string]': 'unknown',
});

const trafficPageType = type({
	records: trafficRecordType.array(),
	total: 'number.integer >= 0',
	'[string]': 'unknown',
});

const debugSummaryBackendType = type({
	backend: 'string',
	data: trafficPageType,
	'[string]': 'unknown',
});

const debugSummaryResponseType = type({
	client: trafficPageType,
	backends: debugSummaryBackendType.array(),
	'[string]': 'unknown',
});

const backendTrafficResponseType = type({
	backend: 'string',
	'method?': 'string',
	'errorsOnly?': 'boolean',
	records: trafficRecordType.array(),
	total: 'number.integer >= 0',
	'[string]': 'unknown',
});

type Tool = typeof toolType.infer;
type ClientTool = typeof clientToolType.infer;
type Prompt = typeof promptType.infer;
type Resource = typeof resourceType.infer;
type ListToolsWithMeta = typeof listToolsWithMetaType.infer;
type ListPromptsWithMeta = typeof listPromptsWithMetaType.infer;
type ListResourcesWithMeta = typeof listResourcesWithMetaType.infer;
type ImplementationInfo = typeof implementationInfoType.infer;
type CapabilitiesInfo = typeof capabilitiesInfoType.infer;
type McpUpstreamStatus = typeof backendStatusType.infer;
type ClientActivity = typeof clientActivityType.infer;
type OverviewResponse = typeof overviewResponseType.infer;
type TrafficRecord = typeof trafficRecordType.infer;
type TrafficPage = typeof trafficPageType.infer;
type DebugSummaryResponse = typeof debugSummaryResponseType.infer;
type BackendTrafficResponse = typeof backendTrafficResponseType.infer;

export type {
	BackendTrafficResponse,
	CapabilitiesInfo,
	ClientActivity,
	ClientTool,
	DebugSummaryResponse,
	ImplementationInfo,
	ListPromptsWithMeta,
	ListResourcesWithMeta,
	ListToolsWithMeta,
	McpUpstreamStatus,
	OverviewResponse,
	Prompt,
	Resource,
	Tool,
	TrafficPage,
	TrafficRecord,
};
export {
	backendStatusType,
	backendTrafficResponseType,
	capabilitiesInfoType,
	clientActivityType,
	clientToolType,
	debugSummaryResponseType,
	implementationInfoType,
	listPromptsWithMetaType,
	listResourcesWithMetaType,
	listToolsWithMetaType,
	overviewResponseType,
	trafficPageType,
	trafficRecordType,
};
