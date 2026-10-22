import { type } from 'arktype';

// A bare host name or IP address, as in a URL without scheme, port or path.
const hostNameType = type('string').narrow(
	(host, ctx) =>
		URL.parse(`http://${host}`)?.hostname === host ||
		ctx.mustBe('a lowercase host name without scheme or port'),
);

// Gateway settings from environment variables, which Bun also loads from the
// env files; the committed `.env` holds every setting, so none has a default
// here.
const environmentType = type({
	PORT: type('string.integer.parse').to('1 <= number <= 65535'),
	ALLOWED_HOSTS: type('string')
		.pipe((value) =>
			value
				.split(',')
				.map((host) => host.trim())
				.filter((host) => host !== ''),
		)
		.to(hostNameType.array().atLeastLength(1)),
	MCP_MAX_SESSIONS_PER_CLIENT: type('string.integer.parse').to('number > 0'),
	'NODE_ENV?': 'string',
});

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

export type { McpConfig, McpServerConfig };
export { environmentType, mcpConfigType };
