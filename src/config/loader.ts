import { type McpConfig, mcpConfigType } from '@/config/schema';
import { errorMessage } from '@/shared/common';

let writeQueue: Promise<unknown> = Promise.resolve();

// Every path comes from the caller, so tests can only touch the files they pass.
const loadRawConfig = async (configPath: string): Promise<unknown> => {
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

const load = async (configPath: string): Promise<McpConfig> => {
	try {
		const contents = await loadRawConfig(configPath);
		return parseConfig(contents);
	} catch (err) {
		throw new Error(`Failed to load "${configPath}": ${errorMessage(err)}`);
	}
};

const persistConfig = async (
	configPath: string,
	config: McpConfig,
): Promise<void> => {
	const snapshot = parseConfig(structuredClone(config));
	const json = `${JSON.stringify(snapshot, null, '\t')}\n`;
	await queueWrite(async () => {
		await Bun.write(configPath, json);
	});
};

const saveToolState = async (params: {
	configPath: string;
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
	await persistConfig(params.configPath, params.config);
};

const saveBackendEnabled = async (params: {
	configPath: string;
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
		await persistConfig(params.configPath, params.config);
	} catch (err) {
		if (server.enabled === params.enabled) {
			server.enabled = previousEnabled;
		}
		throw err;
	}
};

export { load, saveBackendEnabled, saveToolState };
