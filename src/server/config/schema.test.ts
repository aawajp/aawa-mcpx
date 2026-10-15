import { environmentType, mcpConfigType } from '@/server/config/schema';

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

test('environment settings are parsed with their defaults and invalid values are refused', () => {
	expect(environmentType.assert({ ALLOWED_HOSTS: 'localhost' })).toEqual({
		PORT: 4567,
		ALLOWED_HOSTS: ['localhost'],
		MCP_MAX_SESSIONS_PER_CLIENT: 10,
	});
	expect(
		environmentType.assert({
			PORT: '8080',
			ALLOWED_HOSTS: ' mcpx.lan, 192.168.1.10,[fd00::1] ,',
			MCP_MAX_SESSIONS_PER_CLIENT: '3',
			NODE_ENV: 'production',
			HOME: '/home/app',
		}),
	).toMatchObject({
		PORT: 8080,
		ALLOWED_HOSTS: ['mcpx.lan', '192.168.1.10', '[fd00::1]'],
		MCP_MAX_SESSIONS_PER_CLIENT: 3,
		NODE_ENV: 'production',
	});
	for (const env of [
		{},
		{ ALLOWED_HOSTS: '' },
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
	])
		expect(() => environmentType.assert(env)).toThrow();
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
