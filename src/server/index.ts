import path from 'node:path';

import { CONFIG_FILENAME, DATABASE_FILENAME } from '@/server/config/constants';
import { load as loadConfig } from '@/server/config/loader';
import { startServer } from '@/server/gateway/server';
import { logger } from '@/server/logger';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { createTrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

const DEFAULT_PORT = 4567;

const resolvePort = (value: string | undefined): number => {
	if (!value) {
		return DEFAULT_PORT;
	}

	const parsed = Number(value);
	return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
};

const configPath = path.join(process.cwd(), CONFIG_FILENAME);
const config = await loadConfig(configPath);
const trafficStore = createTrafficStore(
	path.join(process.cwd(), DATABASE_FILENAME),
);
const mcpUpstreamManager = createMcpUpstreamManager({
	config,
	configPath,
	trafficStore,
});
const initialization = mcpUpstreamManager.initialize();

void initialization.catch((err) => {
	logger.error(`Backend initialization failed: ${errorMessage(err)}`);
});

const port = resolvePort(process.env.PORT);
const server = await startServer({
	port,
	mcpUpstreamManager,
	trafficStore,
	initialization,
});

logger.info(`🚀 aawa-mcpx gateway running on http://localhost:${port}`);

const shutdown = async () => {
	logger.info('Shutting down aawa-mcpx gateway');
	await server.stop();
	await mcpUpstreamManager.disconnect();
	process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
