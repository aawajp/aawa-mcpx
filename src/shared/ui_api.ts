import { type } from 'arktype';

import {
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
	type toolType,
} from '@/shared/mcp_schemas';

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

const backendStatusSharedFields = {
	serverName: 'string',
	'protocolVersion?': 'string',
	enabled: 'boolean',
	enabledTools: 'string[]',
	availableTools: 'string[]',
	connected: 'boolean',
	'error?': 'string',
	'errorState?': "'runtime' | 'configuration' | 'protocol' | 'authentication'",
	'actionRequired?': 'boolean',
	'implementation?': implementationInfoType,
	'capabilities?': capabilitiesInfoType,
	'instructions?': 'string',
	tools: listToolsResultType,
	prompts: listPromptsResultType,
	resources: listResourcesResultType,
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
	backends: backendStatusType.array(),
	clients: clientActivityType.array(),
	'[string]': 'unknown',
});

const apiErrorType = type({
	error: 'string',
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

const backendTrafficResponseType = type({
	backend: 'string',
	'method?': 'string',
	'errorsOnly?': 'boolean',
	records: trafficRecordType.array(),
	total: 'number.integer >= 0',
	'[string]': 'unknown',
});

type Tool = typeof toolType.infer;
type McpUpstreamStatus = typeof backendStatusType.infer;
type ClientActivity = typeof clientActivityType.infer;
type OverviewResponse = typeof overviewResponseType.infer;
type TrafficRecord = typeof trafficRecordType.infer;
type TrafficPage = typeof trafficPageType.infer;

export type {
	ClientActivity,
	McpUpstreamStatus,
	OverviewResponse,
	Tool,
	TrafficPage,
	TrafficRecord,
};
export {
	apiErrorType,
	backendTrafficResponseType,
	overviewResponseType,
	trafficPageType,
};
