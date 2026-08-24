import path from 'node:path';

import { CONFIG_FILENAME } from '@/config/constants';
import { type McpConfig, mcpConfigType } from '@/config/schema';
import { errorMessage } from '@/shared/common';

let writeQueue: Promise<unknown> = Promise.resolve();

const getConfigPath = (): string => {
	return path.join(process.cwd(), CONFIG_FILENAME);
};

const loadRawConfig = async (): Promise<unknown> => {
	const configPath = getConfigPath();
	const modulePath = `${configPath}?cache=${Date.now()}-${Math.random()}`;
	const module = await import(modulePath, {
		with: {
			type: 'json',
		},
	});
	return module.default;
};

const parseConfig = (contents: unknown): McpConfig => {
	return mcpConfigType.assert(contents);
};

const queueWrite = async <T>(run: () => Promise<T>): Promise<T> => {
	const pending = writeQueue.then(run, run);
	writeQueue = pending.then(
		() => undefined,
		() => undefined,
	);
	return await pending;
};

const load = async (): Promise<McpConfig> => {
	try {
		const contents = await loadRawConfig();
		return parseConfig(contents);
	} catch (err) {
		throw new Error(
			`Failed to load "${CONFIG_FILENAME}": ${errorMessage(err)}`,
		);
	}
};

const persistConfig = async (config: McpConfig): Promise<void> => {
	const snapshot = parseConfig(structuredClone(config));
	const json = `${JSON.stringify(snapshot, null, '\t')}\n`;
	await queueWrite(async () => {
		await Bun.write(getConfigPath(), json);
	});
};

const saveToolState = async (params: {
	config: McpConfig;
	serverName: string;
	enabledTools: string[];
	availableTools: string[];
}): Promise<void> => {
	const enabledTools = Array.from(
		new Set(params.enabledTools.filter((name) => name.trim() !== '')),
	);
	const availableTools = Array.from(
		new Set(params.availableTools.filter((name) => name.trim() !== '')),
	);

	const server = params.config.mcpServers[params.serverName];
	if (!server) {
		throw new Error(`Unknown backend "${params.serverName}"`);
	}
	server.enabledTools = enabledTools;
	server.availableTools = availableTools;
	await persistConfig(params.config);
};

const saveBackendEnabled = async (params: {
	config: McpConfig;
	serverName: string;
	enabled: boolean;
}): Promise<void> => {
	const server = params.config.mcpServers[params.serverName];
	if (!server) {
		throw new Error(`Unknown backend "${params.serverName}"`);
	}
	const previousEnabled = server.enabled;
	server.enabled = params.enabled;
	try {
		await persistConfig(params.config);
	} catch (err) {
		if (server.enabled === params.enabled) {
			server.enabled = previousEnabled;
		}
		throw err;
	}
};

export { load, saveBackendEnabled, saveToolState };
