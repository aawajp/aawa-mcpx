import path from 'node:path';

import { CONFIG_FILENAME, DATABASE_FILENAME } from '@/server/config/constants';
import { load as loadConfig } from '@/server/config/loader';
import { environmentType } from '@/server/config/schema';
import { startServer } from '@/server/gateway/server';
import { logger } from '@/server/logger';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { createTrafficStore } from '@/server/traffic_store';
import { errorMessage } from '@/shared/common';

const environment = environmentType.assert(process.env);

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

const server = await startServer({
	port: environment.PORT,
	development: environment.NODE_ENV !== 'production',
	maxSessionsPerClient: environment.MCP_MAX_SESSIONS_PER_CLIENT,
	mcpUpstreamManager,
	trafficStore,
	initialization,
});

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) {
		process.exit(1);
	}
	shuttingDown = true;
	logger.info('Shutting down');
	await server.stop();
	await mcpUpstreamManager.disconnect();
	process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
