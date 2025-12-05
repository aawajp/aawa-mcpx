import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	LoadConfigResult,
	McpConfig,
	McpServerConfig,
	ValidateConfigParams,
} from '@/config/types';

const CONFIG_FILENAME = 'mcp.json';
const DEFAULT_TIMEOUT = 30000;

const assertObject = (
	value: unknown,
	message: string,
): Record<string, unknown> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
};

const normalizeServerConfig = (
	serverName: string,
	rawConfig: unknown,
): McpServerConfig | null => {
	const configObject = assertObject(
		rawConfig,
		`Server configuration for "${serverName}" must be an object`,
	);

	const url = configObject.url;
	if (typeof url !== 'string' || url.trim() === '') {
		throw new Error(`Server "${serverName}" is missing a valid "url"`);
	}

	const type = configObject.type ?? configObject.transport;
	if (type !== 'http') {
		throw new Error(
			`Server "${serverName}" must use type "http" (Streamable HTTP); found "${String(type)}"`,
		);
	}

	const headersRaw = configObject.headers;
	let headers: Record<string, string> | undefined;
	if (headersRaw !== undefined) {
		const headersObject = assertObject(
			headersRaw,
			`Server "${serverName}" headers must be an object of strings`,
		);
		headers = {};
		for (const [key, value] of Object.entries(headersObject)) {
			if (typeof value !== 'string') {
				throw new Error(
					`Header "${key}" for server "${serverName}" must be a string`,
				);
			}
			headers[key] = value;
		}
	}

	const timeoutRaw = configObject.timeout;
	if (
		timeoutRaw !== undefined &&
		(typeof timeoutRaw !== 'number' || timeoutRaw <= 0)
	) {
		throw new Error(
			`Server "${serverName}" timeout must be a positive number if provided`,
		);
	}
	const timeout = typeof timeoutRaw === 'number' ? timeoutRaw : DEFAULT_TIMEOUT;

	const enabledRaw = configObject.enabled;
	if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
		throw new Error(
			`Server "${serverName}" enabled flag must be a boolean if provided`,
		);
	}
	const enabled = enabledRaw ?? true;

	if (!enabled) {
		return null;
	}

	return {
		type,
		url,
		headers,
		timeout,
		enabled,
	};
};

const validate = (params: ValidateConfigParams): McpConfig => {
	const { config } = params;
	const root = assertObject(config, 'Configuration root must be an object');

	if (!('mcpServers' in root)) {
		throw new Error('Configuration must include "mcpServers"');
	}

	const serversRaw = (root as Record<string, unknown>).mcpServers;
	const serversObject = assertObject(
		serversRaw,
		'"mcpServers" must be an object',
	);

	const normalizedServers: Record<string, McpServerConfig> = {};
	for (const [serverName, rawConfig] of Object.entries(serversObject)) {
		if (serverName.trim() === '') {
			throw new Error('Server names in "mcpServers" cannot be empty');
		}

		const normalized = normalizeServerConfig(serverName, rawConfig);
		if (normalized) {
			normalizedServers[serverName] = normalized;
		}
	}

	return { mcpServers: normalizedServers };
};

const load = async (): Promise<LoadConfigResult> => {
	const configPath = path.join(process.cwd(), CONFIG_FILENAME);

	let fileContents: string;
	try {
		fileContents = await readFile(configPath, 'utf8');
	} catch (error) {
		const errorMessage =
			(error as NodeJS.ErrnoException).code === 'ENOENT'
				? `Configuration file "${CONFIG_FILENAME}" not found`
				: `Failed to read "${CONFIG_FILENAME}": ${(error as Error).message}`;
		throw new Error(errorMessage);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fileContents);
	} catch (error) {
		throw new Error(
			`Invalid JSON in "${CONFIG_FILENAME}": ${(error as Error).message}`,
		);
	}

	const config = validate({ config: parsed });
	return { config };
};

export { load, validate };
