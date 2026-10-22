import { type ArkErrors, type } from 'arktype';

// A setting, file or database the operator must fix first; restarting the
// gateway does not help.
class ConfigurationError extends Error {}

// ArkType's validation errors on one line.
const describeErrors = (errors: ArkErrors) =>
	errors.map((error) => error.message).join('; ');

// A bare host name or IP address, as in a URL without scheme, port or path.
const hostNameType = type('string').narrow(
	(host, ctx) =>
		URL.parse(`http://${host}`)?.hostname === host ||
		ctx.mustBe('a lowercase host name without scheme or port'),
);

const commaListType = type('string').pipe((value) =>
	value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== ''),
);

// The security design allows plain HTTP only on the local machine.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const secureUrlType = type('string.url.parse').narrow(
	(url, ctx) =>
		url.protocol === 'https:' ||
		(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) ||
		ctx.mustBe('an https URL (http only for localhost, 127.0.0.1 or [::1])'),
);

const secondsType = type('string.integer.parse').to('number > 0');

// Dashboard sessions, with OIDC or the superadmin.
const sessionFields = {
	PUBLIC_URL: secureUrlType
		.narrow(
			(url, ctx) =>
				(url.pathname === '/' && url.search === '' && url.hash === '') ||
				ctx.mustBe('an origin without path, query or fragment'),
		)
		.pipe((url) => url.origin),
	UI_SESSION_MAX_AGE: secondsType,
	UI_SESSION_IDLE_TIMEOUT: secondsType,
} as const;

// Settings needed only with ENABLE_OIDC=true.
const oidcFields = {
	ENABLE_OIDC: type("'true'").pipe(() => true as const),
	OIDC_ISSUER: secureUrlType,
	OIDC_CLIENT_ID: 'string > 0',
	OIDC_CLIENT_SECRET: 'string > 0',
	// Every scope requested: by the dashboard login, MCP clients and API keys.
	OIDC_SCOPES: commaListType.to('string[] >= 1'),
	OIDC_ROLES_CLAIM: 'string > 0',
	// Required `aud` of OAuth access tokens on /mcp.
	OIDC_AUDIENCE: 'string > 0',
	ADMIN_ROLES: commaListType.to('string[] >= 1'),
} as const;

const oidcOff = {
	ENABLE_OIDC: type("'false'").pipe(() => false as const),
} as const;

// A Bun.password hash names its algorithm after the first `$`. Env files
// expand `$NAME`, so an unescaped hash arrives mangled and is refused here.
const passwordHashType = type('string').narrow(
	(hash, ctx) =>
		/^\$(argon2(id|i|d)|2[aby])\$/.test(hash) ||
		ctx.mustBe('a Bun.password hash, with each $ written as \\$ in env files'),
);

// Settings needed only with ENABLE_SUPERADMIN=true.
const superadminFields = {
	ENABLE_SUPERADMIN: type("'true'").pipe(() => true as const),
	SUPERADMIN_USERNAME: 'string > 0',
	SUPERADMIN_PASSWORD_HASH: passwordHashType,
} as const;

const superadminOff = {
	ENABLE_SUPERADMIN: type("'false'").pipe(() => false as const),
} as const;

// Gateway settings from environment variables, which Bun also loads from the
// env files; the committed `.env` holds every setting, so none has a default
// here. Settings of a switched-off login method are ignored, and the session
// settings too when both are off.
const environmentType = type({
	PORT: type('string.integer.parse').to('1 <= number <= 65535'),
	ALLOWED_HOSTS: commaListType.to(hostNameType.array().atLeastLength(1)),
	MCP_MAX_SESSIONS_PER_CLIENT: type('string.integer.parse').to('number > 0'),
	MCP_MAX_SESSIONS_PER_USER: type('string.integer.parse').to('number > 0'),
	'NODE_ENV?': 'string',
}).and(
	type({
		...sessionFields,
		...oidcFields,
		...superadminFields,
	})
		.or({
			...sessionFields,
			...oidcFields,
			...superadminOff,
		})
		.or({
			...sessionFields,
			...oidcOff,
			...superadminFields,
		})
		.or({
			...oidcOff,
			...superadminOff,
		}),
);

type Environment = typeof environmentType.infer;

const parseEnvironment = (env: Record<string, string | undefined>) => {
	const parsed = environmentType(env);
	if (parsed instanceof type.errors)
		throw new ConfigurationError(`Invalid settings: ${describeErrors(parsed)}`);
	return parsed;
};

// Backend settings from `mcp.json` in the working directory.
const sharedFields = {
	'timeout': 'number.integer > 0 = 10000',
	'enabled': 'boolean = true',
	'trafficLimit': 'number.integer > 0 = 1',
	'enabledTools?': 'string[]',
	'availableTools?': 'string[]',
} as const;

const mcpServerConfig = type(
	{
		'+': 'reject',
		type: "'http'",
		url: type('string.url').and(/^https?:\/\//),
		'headers?': 'Record<string, string>',
		...sharedFields,
	},
	'|',
	{
		'+': 'reject',
		type: "'stdio'",
		command: 'string > 0',
		'args?': 'string[]',
		'env?': 'Record<string, string>',
		'cwd?': 'string',
		...sharedFields,
	},
);

type McpServerConfig = typeof mcpServerConfig.infer;

const mcpConfigType = type({
	'+': 'reject',
	mcpServers: {
		'[string]': mcpServerConfig,
	},
});

type McpConfig = typeof mcpConfigType.infer;

export type { Environment, McpConfig, McpServerConfig };
export {
	ConfigurationError,
	describeErrors,
	environmentType,
	mcpConfigType,
	parseEnvironment,
};
