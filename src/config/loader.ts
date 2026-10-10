import { type McpConfig, mcpConfigType } from '@/config/schema';
import { errorMessage } from '@/shared/common';

let writeQueue: Promise<unknown> = Promise.resolve();

type RawConfig = {
	mcpServers: Record<string, Record<string, unknown>>;
};

// The file as last read or written for each loaded config. Saves change only
// the fields the gateway owns, so defaults filled in at load stay out of it.
// A config built in code (tests) is written in full on its first save.
const savedConfigs = new WeakMap<McpConfig, RawConfig>();

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
		const config = parseConfig(structuredClone(contents));
		savedConfigs.set(config, contents as RawConfig);
		return config;
	} catch (err) {
		throw new Error(`Failed to load "${configPath}": ${errorMessage(err)}`);
	}
};

const saveServerFields = async (params: {
	configPath: string;
	config: McpConfig;
	serverName: string;
	fields: Record<string, unknown>;
}): Promise<void> => {
	await queueWrite(async () => {
		const saved = savedConfigs.get(params.config);
		const base = saved ?? (structuredClone(params.config) as RawConfig);
		const server = base.mcpServers[params.serverName];
		if (!server) throw new Error(`Unknown backend "${params.serverName}"`);
		const next = {
			...base,
			mcpServers: {
				...base.mcpServers,
				[params.serverName]: {
					...server,
					...params.fields,
				},
			},
		};
		if (!saved || JSON.stringify(next) !== JSON.stringify(saved))
			await Bun.write(
				params.configPath,
				`${JSON.stringify(next, null, '\t')}\n`,
			);
		savedConfigs.set(params.config, next);
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
	await saveServerFields({
		...params,
		fields: {
			enabledTools,
			availableTools,
		},
	});
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
		await saveServerFields({
			...params,
			fields: {
				enabled: params.enabled,
			},
		});
	} catch (err) {
		if (server.enabled === params.enabled) {
			server.enabled = previousEnabled;
		}
		throw err;
	}
};

export { load, saveBackendEnabled, saveToolState };
