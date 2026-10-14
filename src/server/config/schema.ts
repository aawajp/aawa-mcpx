import { type } from 'arktype';

// Gateway settings from environment variables; Bun also loads them from `.env`.
const environmentType = type({
	PORT: type('string.integer.parse').to('1 <= number <= 65535').default('4567'),
	MCP_MAX_SESSIONS_PER_CLIENT: type('string.integer.parse')
		.to('number > 0')
		.default('10'),
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
