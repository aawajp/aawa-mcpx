import path from 'node:path';

import { discoverIssuer } from '@/server/auth/identity';
import { createMcpAuth } from '@/server/auth/mcp_auth';
import { createUiAuth } from '@/server/auth/ui_auth';
import {
	CONFIG_FILENAME,
	EXIT_CODES,
	MAIN_DATABASE_FILENAME,
	TRAFFIC_DATABASE_FILENAME,
} from '@/server/config/constants';
import { load as loadConfig } from '@/server/config/loader';
import {
	ConfigurationError,
	type Environment,
	parseEnvironment,
} from '@/server/config/schema';
import { createAccessStore } from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { createTrafficStore } from '@/server/db/traffic';
import { createUiSessionStore } from '@/server/db/ui_sessions';
import { startServer } from '@/server/gateway/server';
import { logFields, logger } from '@/server/logger';
import { createMcpUpstreamManager } from '@/server/mcp_upstreams/manager';
import { errorMessage } from '@/shared/common';

import type { Database } from 'bun:sqlite';

// A startup failure that may pass on a later try.
class TemporaryError extends Error {}

const temporary = <T>(failure: string, step: Promise<T>): Promise<T> =>
	step.catch((error: unknown) => {
		throw new TemporaryError(`${failure}: ${errorMessage(error)}`);
	});

// With OIDC, the superadmin, or both, the dashboard needs a login and /mcp
// credentials; with neither, neither does.
const createAuth = async (
	env: Exclude<Environment, { ENABLE_OIDC: false; ENABLE_SUPERADMIN: false }>,
	mainDatabase: Database,
) => {
	const access = createAccessStore(mainDatabase);
	const oidc = env.ENABLE_OIDC
		? {
				config: await temporary(
					'OIDC discovery failed',
					discoverIssuer(
						env.OIDC_ISSUER,
						env.OIDC_CLIENT_ID,
						env.OIDC_CLIENT_SECRET,
					),
				),
				clientId: env.OIDC_CLIENT_ID,
				scopes: env.OIDC_SCOPES,
				rolesClaim: env.OIDC_ROLES_CLAIM,
				adminRoles: env.ADMIN_ROLES,
				audience: env.OIDC_AUDIENCE,
			}
		: undefined;
	const superadmin = env.ENABLE_SUPERADMIN
		? {
				userId: access.ensureSuperadmin(env.SUPERADMIN_USERNAME).id,
				username: env.SUPERADMIN_USERNAME,
				passwordHash: env.SUPERADMIN_PASSWORD_HASH,
			}
		: undefined;
	const ui = createUiAuth({
		publicUrl: env.PUBLIC_URL,
		maxAgeSeconds: env.UI_SESSION_MAX_AGE,
		idleTimeoutSeconds: env.UI_SESSION_IDLE_TIMEOUT,
		sessions: createUiSessionStore(mainDatabase),
		access,
		oidc,
		superadmin,
	});
	const removedSessions = ui.removeInvalidSessions();
	if (removedSessions > 0)
		logger.info(
			`Auth startup: ${logFields({
				op: 'remove_sessions',
				count: removedSessions,
			})}`,
		);
	return {
		ui,
		mcp: createMcpAuth({
			access,
			oidc: oidc && {
				...oidc,
				publicUrl: env.PUBLIC_URL,
			},
		}),
		access,
	};
};

// Starts the gateway; a failure stops it with one log line and an exit code
// that tells whether restarting can help.
const startGateway = async () => {
	const env = parseEnvironment(process.env);

	const configPath = path.join(process.cwd(), CONFIG_FILENAME);
	const config = await loadConfig(configPath);
	const mainDatabase = openMainDatabase(
		path.join(process.cwd(), MAIN_DATABASE_FILENAME),
	);
	const auth =
		env.ENABLE_OIDC || env.ENABLE_SUPERADMIN
			? await createAuth(env, mainDatabase)
			: undefined;
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
			maxSessionsPerUser: env.MCP_MAX_SESSIONS_PER_USER,
			mcpUpstreamManager,
			trafficStore,
			auth,
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
