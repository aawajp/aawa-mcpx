import path from 'node:path';

import {
	CONFIG_FILENAME,
	EXIT_CODES,
	MAIN_DATABASE_FILENAME,
	TRAFFIC_DATABASE_FILENAME,
} from '@/server/config/constants';
import { load as loadConfig } from '@/server/config/loader';
import { ConfigurationError, parseEnvironment } from '@/server/config/schema';
import { openMainDatabase } from '@/server/db/main';
import { createTrafficStore } from '@/server/db/traffic';
import { startServer } from '@/server/gateway/server';
import { logger } from '@/server/logger';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { errorMessage } from '@/shared/common';

// A startup failure that may pass on a later try.
class TemporaryError extends Error {}

const temporary = <T>(failure: string, step: Promise<T>): Promise<T> =>
	step.catch((error: unknown) => {
		throw new TemporaryError(`${failure}: ${errorMessage(error)}`);
	});

// Starts the gateway; a failure stops it with one log line and an exit code
// that tells whether restarting can help.
const startGateway = async () => {
	const env = parseEnvironment(process.env);

	const configPath = path.join(process.cwd(), CONFIG_FILENAME);
	const config = await loadConfig(configPath);
	const mainDatabase = openMainDatabase(
		path.join(process.cwd(), MAIN_DATABASE_FILENAME),
	);
	const trafficStore = createTrafficStore(
		path.join(process.cwd(), TRAFFIC_DATABASE_FILENAME),
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

	const server = await temporary(
		'Listening failed',
		startServer({
			port: env.PORT,
			allowedHosts: env.ALLOWED_HOSTS,
			development: env.NODE_ENV === 'development',
			maxSessionsPerClient: env.MCP_MAX_SESSIONS_PER_CLIENT,
			mcpUpstreamManager,
			trafficStore,
			initialization,
		}),
	);

	return {
		server,
		mcpUpstreamManager,
		mainDatabase,
	};
};

const { server, mcpUpstreamManager, mainDatabase } = await startGateway().catch(
	(error: unknown) => {
		logger.error(`Startup failed: ${errorMessage(error)}`);
		return process.exit(
			error instanceof ConfigurationError
				? EXIT_CODES.configuration
				: error instanceof TemporaryError
					? EXIT_CODES.temporary
					: EXIT_CODES.unexpected,
		);
	},
);

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) {
		process.exit(1);
	}
	shuttingDown = true;
	logger.info('Shutting down');
	await server.stop();
	await mcpUpstreamManager.disconnect();
	mainDatabase.close();
	process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
