type McpServerConfig = {
	type: 'http';
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
};

type McpConfig = {
	mcpServers: Record<string, McpServerConfig>;
};

type LoadConfigResult = {
	config: McpConfig;
};

type ValidateConfigParams = {
	config: unknown;
};

export type {
	McpConfig,
	McpServerConfig,
	LoadConfigResult,
	ValidateConfigParams,
};
