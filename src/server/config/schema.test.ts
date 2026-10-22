import {
	ConfigurationError,
	environmentType,
	mcpConfigType,
	parseEnvironment,
} from '@/server/config/schema';

import { expect, test } from 'bun:test';

test('backend enabled setting defaults to true', () => {
	const defaultConfig = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://127.0.0.1:3000/mcp',
			},
		},
	});
	expect(defaultConfig.mcpServers.mock?.enabled).toBe(true);

	const disabledConfig = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://127.0.0.1:3000/mcp',
				enabled: false,
			},
		},
	});
	expect(disabledConfig.mcpServers.mock?.enabled).toBe(false);
});

// Every setting is required: the committed `.env` holds the defaults.
const baseEnvironment = {
	PORT: '4567',
	ALLOWED_HOSTS: 'localhost',
	MCP_MAX_SESSIONS_PER_CLIENT: '10',
	MCP_MAX_SESSIONS_PER_USER: '100',
};

test('login settings are ignored when both login methods are off', () => {
	const expected = {
		PORT: 4567,
		ALLOWED_HOSTS: ['localhost'],
		MCP_MAX_SESSIONS_PER_CLIENT: 10,
		MCP_MAX_SESSIONS_PER_USER: 100,
		ENABLE_OIDC: false as const,
		ENABLE_SUPERADMIN: false as const,
	};
	expect(
		environmentType.assert({
			...baseEnvironment,
			ENABLE_OIDC: 'false',
			ENABLE_SUPERADMIN: 'false',
		}),
	).toEqual(expected);
	expect(
		environmentType.assert({
			...baseEnvironment,
			ENABLE_OIDC: 'false',
			ENABLE_SUPERADMIN: 'false',
			PUBLIC_URL: 'http://mcpx.example',
			ADMIN_ROLES: '',
			SUPERADMIN_PASSWORD_HASH: 'plain',
		}),
	).toMatchObject(expected);
});

const sessionEnvironment = {
	PUBLIC_URL: 'https://mcpx.example',
	UI_SESSION_MAX_AGE: '28800',
	UI_SESSION_IDLE_TIMEOUT: '3600',
};

const oidcEnvironment = {
	ENABLE_OIDC: 'true',
	OIDC_ISSUER: 'https://idp.example/tenant',
	OIDC_CLIENT_ID: 'client',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_ROLES_CLAIM: 'roles',
	OIDC_AUDIENCE: 'gateway',
	OIDC_SCOPES: 'openid',
	ADMIN_ROLES: 'admin',
};

// Only the algorithm prefix is checked.
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=2,p=1$salt$hash';

const superadminEnvironment = {
	ENABLE_SUPERADMIN: 'true',
	SUPERADMIN_USERNAME: 'admin',
	SUPERADMIN_PASSWORD_HASH: PASSWORD_HASH,
};

const requiredEnvironment = {
	...baseEnvironment,
	...sessionEnvironment,
	...oidcEnvironment,
	...superadminEnvironment,
};

test('environment settings are parsed and missing or invalid values are refused', () => {
	expect(environmentType.assert(requiredEnvironment)).toEqual({
		PORT: 4567,
		ALLOWED_HOSTS: ['localhost'],
		MCP_MAX_SESSIONS_PER_CLIENT: 10,
		MCP_MAX_SESSIONS_PER_USER: 100,
		ENABLE_OIDC: true,
		PUBLIC_URL: 'https://mcpx.example',
		OIDC_ISSUER: new URL('https://idp.example/tenant'),
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: ['openid'],
		OIDC_ROLES_CLAIM: 'roles',
		OIDC_AUDIENCE: 'gateway',
		ADMIN_ROLES: ['admin'],
		UI_SESSION_MAX_AGE: 28800,
		UI_SESSION_IDLE_TIMEOUT: 3600,
		ENABLE_SUPERADMIN: true,
		SUPERADMIN_USERNAME: 'admin',
		SUPERADMIN_PASSWORD_HASH: PASSWORD_HASH,
	});
	expect(
		environmentType.assert({
			...requiredEnvironment,
			PORT: '8080',
			ALLOWED_HOSTS: ' mcpx.lan, 192.168.1.10,[fd00::1] ,',
			MCP_MAX_SESSIONS_PER_CLIENT: '3',
			MCP_MAX_SESSIONS_PER_USER: '30',
			PUBLIC_URL: 'http://localhost:4567/',
			OIDC_ISSUER: 'http://127.0.0.1:8080',
			OIDC_SCOPES: 'openid, groups',
			ADMIN_ROLES: 'admin, ops',
			UI_SESSION_MAX_AGE: '600',
			UI_SESSION_IDLE_TIMEOUT: '60',
			NODE_ENV: 'production',
			HOME: '/home/app',
		}),
	).toMatchObject({
		PORT: 8080,
		ALLOWED_HOSTS: ['mcpx.lan', '192.168.1.10', '[fd00::1]'],
		MCP_MAX_SESSIONS_PER_CLIENT: 3,
		MCP_MAX_SESSIONS_PER_USER: 30,
		PUBLIC_URL: 'http://localhost:4567',
		OIDC_SCOPES: ['openid', 'groups'],
		ADMIN_ROLES: ['admin', 'ops'],
		UI_SESSION_MAX_AGE: 600,
		UI_SESSION_IDLE_TIMEOUT: 60,
		NODE_ENV: 'production',
	});
	for (const env of [
		{},
		{ ALLOWED_HOSTS: '' },
		{ PORT: undefined },
		{ MCP_MAX_SESSIONS_PER_CLIENT: undefined },
		{ MCP_MAX_SESSIONS_PER_USER: undefined },
		{ ENABLE_OIDC: undefined },
		{ ENABLE_SUPERADMIN: undefined },
		{ OIDC_SCOPES: ' , ' },
		{ UI_SESSION_MAX_AGE: undefined },
		{ ALLOWED_HOSTS: ' , ' },
		{ PORT: '' },
		{ PORT: 'abc' },
		{ PORT: '-1' },
		{ PORT: '1.5' },
		{ PORT: '65536' },
		{ ALLOWED_HOSTS: 'mcpx.lan:4567' },
		{ ALLOWED_HOSTS: 'http://mcpx.lan' },
		{ ALLOWED_HOSTS: 'MCPX.lan' },
		{ ALLOWED_HOSTS: 'fd00::1' },
		{ MCP_MAX_SESSIONS_PER_CLIENT: '0' },
		{ MCP_MAX_SESSIONS_PER_USER: '0' },
		{ ENABLE_OIDC: 'yes' },
		{ ENABLE_OIDC: 'TRUE' },
		{ ENABLE_SUPERADMIN: '1' },
		{ PUBLIC_URL: undefined },
		{ PUBLIC_URL: 'mcpx.example' },
		{ PUBLIC_URL: 'http://mcpx.example' },
		{ PUBLIC_URL: 'http://192.168.1.10:4567' },
		{ PUBLIC_URL: 'https://mcpx.example/gateway' },
		{ PUBLIC_URL: 'https://mcpx.example/?a=1' },
		{ OIDC_ISSUER: 'http://idp.example' },
		{ OIDC_ISSUER: 'ftp://localhost' },
		{ OIDC_CLIENT_ID: '' },
		{ OIDC_CLIENT_SECRET: undefined },
		{ OIDC_ROLES_CLAIM: '' },
		{ ADMIN_ROLES: ' , ' },
		{ UI_SESSION_MAX_AGE: '0' },
		{ UI_SESSION_IDLE_TIMEOUT: '1.5' },
		{ SUPERADMIN_USERNAME: '' },
		{ SUPERADMIN_PASSWORD_HASH: undefined },
		{ SUPERADMIN_PASSWORD_HASH: 'secret' },
		// An unescaped hash, after the env file expanded its `$` parts.
		{ SUPERADMIN_PASSWORD_HASH: '=19=65536,t=2,p=1' },
	])
		expect(() =>
			environmentType.assert(
				Object.keys(env).length === 0
					? env
					: {
							...requiredEnvironment,
							...env,
						},
			),
		).toThrow();
});

test('each login method needs only its own settings and the session settings', () => {
	expect(
		environmentType.assert({
			...baseEnvironment,
			...sessionEnvironment,
			...superadminEnvironment,
			ENABLE_OIDC: 'false',
		}),
	).toMatchObject({
		ENABLE_OIDC: false,
		ENABLE_SUPERADMIN: true,
		SUPERADMIN_USERNAME: 'admin',
	});
	expect(
		environmentType.assert({
			...baseEnvironment,
			...sessionEnvironment,
			...oidcEnvironment,
			ENABLE_SUPERADMIN: 'false',
		}),
	).toMatchObject({
		ENABLE_OIDC: true,
		ENABLE_SUPERADMIN: false,
	});
	expect(() =>
		environmentType.assert({
			...baseEnvironment,
			...superadminEnvironment,
			ENABLE_OIDC: 'false',
		}),
	).toThrow();
});

test('mcp.json refuses unknown keys, non-HTTP URLs and empty commands', () => {
	for (const config of [
		{
			mcpServers: {},
			servers: {},
		},
		{
			mcpServers: {
				mock: {
					type: 'http',
					url: 'http://127.0.0.1:3000/mcp',
					enable: false,
				},
			},
		},
		{
			mcpServers: {
				mock: {
					type: 'http',
					url: 'file:///tmp/mcp',
				},
			},
		},
		{
			mcpServers: {
				mock: {
					type: 'stdio',
					command: '',
				},
			},
		},
	])
		expect(() => mcpConfigType.assert(config)).toThrow();
});

test('invalid settings are a configuration error, listed on one line', () => {
	expect(() =>
		parseEnvironment({
			...requiredEnvironment,
			PORT: 'abc',
			SUPERADMIN_USERNAME: '',
		}),
	).toThrow(
		new ConfigurationError(
			'Invalid settings: PORT must be a well-formed integer string (was "abc"); SUPERADMIN_USERNAME must be non-empty',
		),
	);
});
