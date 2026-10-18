import { type } from 'arktype';

import { clientInfoType } from '@/shared/client_info';
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

// Dashboard pages; everything else the dashboard uses lives under /api.
const UI_PAGE_PATHS = {
	main: '/ui',
	debug: '/ui/debug',
} as const;

const capabilitiesInfoType = type('Record<string, unknown>');

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

// The dashboard shows each backend's status with its catalogs.
const backendOverviewType = backendStatusType.and({
	tools: listToolsResultType,
	prompts: listPromptsResultType,
	resources: listResourcesResultType,
});

const overviewResponseType = type({
	'protocolVersion?': 'string',
	'supportedProtocolVersions?': 'string[]',
	backends: backendOverviewType.array(),
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
});

const trafficPageType = type({
	records: trafficRecordType.array(),
	total: 'number.integer >= 0',
});

const backendTrafficResponseType = trafficPageType.and({
	backend: 'string',
	'method?': 'string',
	'errorsOnly?': 'boolean',
});

type Tool = typeof toolType.infer;
type McpUpstreamStatus = typeof backendStatusType.infer;
type BackendOverview = typeof backendOverviewType.infer;
type ClientActivity = typeof clientActivityType.infer;
type OverviewResponse = typeof overviewResponseType.infer;
type TrafficRecord = typeof trafficRecordType.infer;
type TrafficPage = typeof trafficPageType.infer;

export type {
	BackendOverview,
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
	UI_PAGE_PATHS,
};
