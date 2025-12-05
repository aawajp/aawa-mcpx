import { createBackendManager } from '@/backend/manager';
import { load as loadConfig } from '@/config/loader';
import { startServer } from '@/gateway/server';
import { logger } from '@/utils/logger';
import { createTrafficStore } from '@/utils/trafficStore';

const DEFAULT_PORT = 4567;

const resolvePort = (value: string | undefined): number => {
	if (!value) {
		return DEFAULT_PORT;
	}

	const parsed = Number(value);
	return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
};

const { config } = await loadConfig();
const trafficStore = createTrafficStore();
const backendManager = createBackendManager({ config, trafficStore });

const port = resolvePort(process.env.PORT);
const server = await startServer({ port, backendManager, trafficStore });

void backendManager.initialize().catch((error) => {
	logger.error(`Backend initialization failed: ${(error as Error).message}`);
});

logger.info(`🚀 aawa-mcpx gateway running on http://localhost:${port}`);

const shutdown = async () => {
	logger.info('Shutting down aawa-mcpx gateway');
	await server.stop();
	await backendManager.disconnect();
	process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
