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
	login: '/ui/login',
} as const;

const AUTH_PATHS = {
	// The login methods that are on, for the login page.
	methods: '/api/auth/methods',
	// OIDC login: redirects to the IdP, which returns to the callback.
	login: '/api/auth/login',
	// The superadmin's username and password.
	password: '/api/auth/password',
	callback: '/api/auth/callback',
	logout: '/api/auth/logout',
	session: '/api/auth/session',
} as const;

// The dashboard's gateway data and actions.
const DASHBOARD_PATHS = {
	overview: '/api/overview',
	events: '/api/events',
	health: '/api/health',
	refreshBackends: '/api/backends/refresh',
	toggleBackend: '/api/backends/toggle',
	toggleTool: '/api/tools/toggle',
	debug: '/api/debug',
	clientTraffic: '/api/debug/client',
	backendTraffic: '/api/debug/backend',
} as const;

// MCP client users, roles, permissions and API keys, with a login method on.
const ACCESS_PATHS = {
	state: '/api/access',
	saveUser: '/api/access/users/save',
	deleteUser: '/api/access/users/delete',
	saveRole: '/api/access/roles/save',
	deleteRole: '/api/access/roles/delete',
	savePermissions: '/api/access/permissions/save',
	createKey: '/api/access/keys/create',
	registerKey: '/api/access/keys/register',
	revokeKey: '/api/access/keys/revoke',
} as const;

// /mcp API keys, sent as Bearer tokens; the prefix tells them from a JWT and
// from each other. An OIDC service account's key is this prefix and
// base64url(client ID:secret), built in the browser; the gateway stores only
// its hash.
const OIDC_KEY_PREFIX = 'sk_aawa_api01_';
// A Local user's key is this prefix and random bytes, made by the gateway.
const LOCAL_KEY_PREFIX = 'sk_aawa_local01_';
// The last characters of a key, shown to tell keys apart.
const KEY_HINT_LENGTH = 4;

// The Tester sends one MCP request through /mcp and shows the whole exchange.
const TESTER_PATH = '/api/tester/mcp';

const testerRequestType = type({
	'+': 'reject',
	headers: 'Record<string, string>',
	body: 'unknown',
});

const httpExchangeSideType = type({
	headers: 'Record<string, string>',
	body: 'unknown',
});

const testerResponseType = type({
	request: httpExchangeSideType.and({
		method: 'string',
		url: 'string',
	}),
	response: httpExchangeSideType.and({
		status: 'number.integer',
	}),
});

const REALMS = ['oidc', 'local'] as const;
// Humans sign in themselves; machines, such as service accounts, use API keys.
const USER_TYPES = ['human', 'machine'] as const;

const accessStateType = type({
	users: type({
		id: 'string',
		realm: type.enumerated(...REALMS),
		type: type.enumerated(...USER_TYPES),
		superadmin: 'boolean',
		'name?': 'string',
		'username?': 'string',
		enabled: 'boolean',
		roleIds: 'string[]',
		idpRoles: 'string[]',
		createdAt: 'number',
		'lastSeenAt?': 'number',
	}).array(),
	roles: type({
		id: 'string',
		name: 'string',
		createdAt: 'number',
	}).array(),
	permissions: type({
		holderType: "'user' | 'role'",
		holderId: 'string',
		backend: 'string',
		tool: 'string',
	}).array(),
	apiKeys: type({
		id: 'string',
		userId: 'string',
		label: 'string',
		hint: 'string',
		createdAt: 'number',
		'lastUsedAt?': 'number',
	}).array(),
});

// A new Local key comes once, with the state.
const createdKeyResponseType = accessStateType.and({
	key: 'string',
});

// How screens show a user: its Name, else its User ID.
const userLabel = (user: { id: string; name?: string }): string =>
	user.name || user.id;

// Query parameter of the login path naming the page to return to.
const RETURN_TO_PARAM = 'returnTo';

const uiSessionType = type({
	name: 'string',
});

const logoutResponseType = type({
	logoutUrl: 'string',
});

const loginMethodsType = type({
	oidc: 'boolean',
	password: 'boolean',
	publicUrl: 'string',
});

const passwordLoginResponseType = type({
	returnTo: 'string',
});

const capabilitiesInfoType = type('Record<string, unknown>');

const clientActivityType = type({
	client: clientInfoType,
	// The aawa-mcpx user's label and ID, when the request's credentials named
	// one.
	'user?': 'string',
	'userId?': 'string',
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
type AccessState = typeof accessStateType.infer;
type TesterResponse = typeof testerResponseType.infer;
type McpUpstreamStatus = typeof backendStatusType.infer;
type BackendOverview = typeof backendOverviewType.infer;
type ClientActivity = typeof clientActivityType.infer;
type OverviewResponse = typeof overviewResponseType.infer;
type TrafficRecord = typeof trafficRecordType.infer;
type TrafficPage = typeof trafficPageType.infer;

export type {
	AccessState,
	BackendOverview,
	ClientActivity,
	McpUpstreamStatus,
	OverviewResponse,
	TesterResponse,
	Tool,
	TrafficPage,
	TrafficRecord,
};
export {
	ACCESS_PATHS,
	AUTH_PATHS,
	accessStateType,
	apiErrorType,
	backendTrafficResponseType,
	createdKeyResponseType,
	DASHBOARD_PATHS,
	KEY_HINT_LENGTH,
	LOCAL_KEY_PREFIX,
	loginMethodsType,
	logoutResponseType,
	OIDC_KEY_PREFIX,
	overviewResponseType,
	passwordLoginResponseType,
	REALMS,
	RETURN_TO_PARAM,
	TESTER_PATH,
	testerRequestType,
	testerResponseType,
	trafficPageType,
	UI_PAGE_PATHS,
	USER_TYPES,
	uiSessionType,
	userLabel,
};
