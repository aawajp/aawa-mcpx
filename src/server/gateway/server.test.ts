import { createMcpAuth } from '@/server/auth/mcp_auth';
import { createUiAuth } from '@/server/auth/ui_auth';
import { createAccessStore } from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { createTrafficStore } from '@/server/db/traffic';
import { createUiSessionStore } from '@/server/db/ui_sessions';
import { startServer } from '@/server/gateway/server';
import { logger } from '@/server/logger';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import {
	ACCESS_PATHS,
	AUTH_PATHS,
	DASHBOARD_PATHS,
	TESTER_PATH,
} from '@/shared/ui_api';

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';

const PASSWORD = 'correct horse battery staple';
// No backends.
const manager = {
	getStatuses: () => [],
	listAllTools: () => new Map(),
	listAllPrompts: () => new Map(),
	listAllResources: () => new Map(),
	refreshStaleCatalogs: async () => undefined,
} as unknown as McpUpstreamManager;

const info = spyOn(logger, 'info').mockImplementation(() => undefined);
const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
let passwordHash: string;
beforeAll(async () => {
	passwordHash = await Bun.password.hash(PASSWORD);
});
afterAll(() => {
	info.mockRestore();
	warn.mockRestore();
});

// The gateway as startServer assembles it, with both login methods off or
// with the superadmin's password login.
const start = async (superadmin: boolean) => {
	const db = openMainDatabase(':memory:');
	const access = createAccessStore(db);
	const auth = superadmin
		? {
				ui: createUiAuth({
					publicUrl: 'https://mcpx.test',
					maxAgeSeconds: 3600,
					idleTimeoutSeconds: 3600,
					sessions: createUiSessionStore(db),
					access,
					superadmin: {
						userId: access.ensureSuperadmin('root').id,
						username: 'root',
						passwordHash,
					},
				}),
				mcp: createMcpAuth({
					access,
				}),
				access,
			}
		: undefined;
	const server = await startServer({
		port: 0,
		allowedHosts: ['localhost', 'mcpx.test'],
		development: false,
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 100,
		mcpUpstreamManager: manager,
		trafficStore: createTrafficStore(':memory:'),
		auth,
	});
	const send = (path: string, init: RequestInit = {}) =>
		fetch(`http://localhost:${server.port}${path}`, {
			redirect: 'manual',
			...init,
		});
	return {
		send,
		stop: async () => {
			await server.stop();
			db.close();
		},
	};
};

const post = (body: unknown, headers: Record<string, string> = {}) => ({
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		Origin: 'https://mcpx.test',
		...headers,
	},
	body: JSON.stringify(body),
});

const initialize = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-11-25',
		clientInfo: {
			name: 'server-test',
			version: '1',
		},
	},
};
const mcpHeaders = {
	Accept: 'application/json, text/event-stream',
	'MCP-Protocol-Version': '2025-11-25',
};

test('without login methods, health is minimal and every route is open', async () => {
	const { send, stop } = await start(false);
	try {
		const health = await send(DASHBOARD_PATHS.health);
		expect([health.status, await health.json()]).toEqual([
			200,
			{
				status: 'ok',
			},
		]);
		for (const path of [
			DASHBOARD_PATHS.overview,
			`${DASHBOARD_PATHS.overview}/`,
		])
			expect((await send(path)).status).toBe(200);
		// No Auth API or login without a login method.
		for (const path of [ACCESS_PATHS.state, AUTH_PATHS.methods])
			expect((await send(path)).status).toBe(404);
		expect((await send('/mcp', post(initialize, mcpHeaders))).status).toBe(200);
		expect((await send('/mcp', { method: 'PUT' })).status).toBe(405);
		// Other hosts are refused before any route.
		for (const path of [DASHBOARD_PATHS.health, '/mcp', '/nothing'])
			expect(
				(
					await send(path, {
						headers: {
							Host: 'evil.test',
						},
					})
				).status,
			).toBe(403);
	} finally {
		await stop();
	}
});

test('with the password login, only health and login routes are open', async () => {
	const { send, stop } = await start(true);
	try {
		const health = await send(DASHBOARD_PATHS.health);
		expect([health.status, await health.json()]).toEqual([
			200,
			{
				status: 'ok',
			},
		]);
		const protectedPaths = [
			DASHBOARD_PATHS.overview,
			DASHBOARD_PATHS.debug,
			DASHBOARD_PATHS.events,
			ACCESS_PATHS.state,
		];
		for (const path of protectedPaths)
			expect((await send(path)).status).toBe(401);
		for (const path of [TESTER_PATH, ACCESS_PATHS.saveUser])
			expect((await send(path, post({}))).status).toBe(401);
		expect((await send('/mcp', post(initialize, mcpHeaders))).status).toBe(401);
		const login = await send(
			AUTH_PATHS.password,
			post({
				username: 'root',
				password: PASSWORD,
			}),
		);
		expect(login.status).toBe(200);
		const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
		for (const path of [DASHBOARD_PATHS.overview, ACCESS_PATHS.state])
			expect(
				(
					await send(path, {
						headers: {
							Cookie: cookie,
						},
					})
				).status,
			).toBe(200);
		// Changes need an Origin equal to PUBLIC_URL.
		expect(
			(
				await send(
					ACCESS_PATHS.deleteRole,
					post(
						{
							id: 'none',
						},
						{
							Cookie: cookie,
							Origin: 'https://evil.test',
						},
					),
				)
			).status,
		).toBe(403);
	} finally {
		await stop();
	}
});

test("a notification's long method is stored as its start, outside its request", async () => {
	const { send, stop } = await start(false);
	try {
		const session =
			(await send('/mcp', post(initialize, mcpHeaders))).headers.get(
				'Mcp-Session-Id',
			) ?? '';
		const method = `notifications/${'x'.repeat(80_000)}`;
		const accepted = await send(
			'/mcp',
			post(
				{
					jsonrpc: '2.0',
					method,
				},
				{
					...mcpHeaders,
					'Mcp-Session-Id': session,
				},
			),
		);
		expect(accepted.status).toBe(202);
		const page = await send(
			`${DASHBOARD_PATHS.clientTraffic}?limit=10&offset=0`,
		);
		const [record] = (await page.json()).records;
		expect(record.method).toBe(`${method.slice(0, 256)}…`);
		expect(record.relatedMethod).toBe(record.method);
		// The request itself is within the body limit, so it is kept whole.
		expect(record.request.method).toBe(method);
	} finally {
		await stop();
	}
});
