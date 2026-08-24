import { type } from 'arktype';

const sharedFields = {
	'timeout': 'number.integer > 0 = 10000',
	'enabled': 'boolean = true',
	'trafficLimit': 'number.integer > 0 = 1',
	'enabledTools?': 'string[]',
	'availableTools?': 'string[]',
} as const;

const mcpServerConfig = type(
	{
		type: "'http'",
		url: 'string.url',
		'headers?': 'Record<string, string>',
		...sharedFields,
	},
	'|',
	{
		type: "'stdio'",
		command: 'string',
		'args?': 'string[]',
		'env?': 'Record<string, string>',
		'cwd?': 'string',
		...sharedFields,
	},
);

type McpServerConfig = typeof mcpServerConfig.infer;

const mcpConfigType = type({
	mcpServers: {
		'[string]': mcpServerConfig,
	},
});

type McpConfig = typeof mcpConfigType.infer;

export type { McpConfig, McpServerConfig };
export { mcpConfigType };
