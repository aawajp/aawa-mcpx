import { load as loadConfig } from '@/config/loader';
import { startServer } from '@/gateway/server';
import { createMcpUpstreamManager } from '@/mcp_upstreams/manager';
import { logger } from '@/server/logger';
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

const config = await loadConfig();
const trafficStore = createTrafficStore();
const mcpUpstreamManager = createMcpUpstreamManager({
	config,
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
