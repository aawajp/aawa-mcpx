import { createAccessRoutes } from '@/server/auth/access_routes';
import { discoverIssuer } from '@/server/auth/identity';
import { jwks, signJwt } from '@/server/auth/idp_fixture';
import { createUiAuth } from '@/server/auth/ui_auth';
import { createAccessStore } from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { createUiSessionStore } from '@/server/db/ui_sessions';
import { logger } from '@/server/logger';
import { ACCESS_PATHS, AUTH_PATHS } from '@/shared/ui_api';

import type { Database } from 'bun:sqlite';
import {
	afterAll,
	afterEach,
	beforeAll,
	expect,
	it,
	setSystemTime,
	spyOn,
} from 'bun:test';

const PUBLIC_URL = 'https://mcpx.test';
const CLIENT_ID = 'gateway';
const CLIENT_SECRET = 'gateway-secret';
const ROLES_CLAIM = 'roles';

// Route handlers get the server too, for the client's address.
type Server = { requestIP: (request: Request) => { address: string } | null };
type Handler = (
	request: Request,
	server: Server,
) => Response | Promise<Response>;
type Routes = Record<string, Record<string, Handler>>;

// A local OpenID provider: discovery, JWKS and a token endpoint that checks
// PKCE and returns an ID token with the claims given to the next code.
const codes = new Map<
	string,
	{ claims: Record<string, unknown>; challenge: string; nonce: string }
>();
// The refresh token the token endpoint accepts; each refresh rotates it.
let refreshToken = '';
let refreshes = 0;

// HTTP Basic client authentication form-encodes the ID and secret (RFC 6749
// section 2.3.1).
const basicCredentials = (request: Request) =>
	atob(request.headers.get('authorization')?.replace(/^Basic /, '') ?? '')
		.split(':')
		.map(decodeURIComponent)
		.join(':');

let issuer: string;
const idp = Bun.serve({
	port: 0,
	routes: {
		'/.well-known/openid-configuration': () =>
			Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				end_session_endpoint: `${issuer}/logout`,
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
			}),
		'/jwks': () => Response.json(jwks),
		'/token': {
			async POST(request) {
				const body = new URLSearchParams(await request.text());
				if (body.get('grant_type') === 'refresh_token') {
					refreshes += 1;
					if (body.get('refresh_token') !== refreshToken)
						return Response.json(
							{
								error: 'invalid_grant',
							},
							{
								status: 400,
							},
						);
					refreshToken = `refresh-${refreshes}`;
					return Response.json({
						access_token: `access-${refreshes}`,
						token_type: 'Bearer',
						expires_in: 300,
						refresh_token: refreshToken,
					});
				}
				const grant = codes.get(body.get('code') ?? '');
				const challenge = new Bun.CryptoHasher('sha256')
					.update(body.get('code_verifier') ?? '')
					.digest('base64url');
				if (
					!grant ||
					grant.challenge !== challenge ||
					basicCredentials(request) !== `${CLIENT_ID}:${CLIENT_SECRET}` ||
					body.has('client_secret') ||
					body.get('redirect_uri') !== `${PUBLIC_URL}${AUTH_PATHS.callback}`
				)
					return Response.json(
						{
							error: 'invalid_grant',
						},
						{
							status: 400,
						},
					);
				return Response.json({
					access_token: 'access',
					token_type: 'Bearer',
					expires_in: 300,
					id_token: await signJwt({
						iss: issuer,
						aud: CLIENT_ID,
						nonce: grant.nonce,
						...grant.claims,
					}),
				});
			},
		},
	},
});
issuer = `http://127.0.0.1:${idp.port}`;

let db: Database;
let routes: Routes;
let uiAuth: ReturnType<typeof createUiAuth>;

const SUPERADMIN_USERNAME = 'root';
const SUPERADMIN_PASSWORD = 'correct horse battery staple';

const createAuth = async ({
	oidc = true,
	superadmin = false,
}: {
	oidc?: boolean;
	superadmin?: boolean;
} = {}) => {
	const access = createAccessStore(db);
	return createUiAuth({
		oidc: oidc
			? {
					config: await discoverIssuer(
						new URL(issuer),
						CLIENT_ID,
						CLIENT_SECRET,
					),
					clientId: CLIENT_ID,
					scopes: ['openid', 'profile', 'email'],
					rolesClaim: ROLES_CLAIM,
					adminRoles: ['admin'],
				}
			: undefined,
		superadmin: superadmin
			? {
					userId: access.ensureSuperadmin(SUPERADMIN_USERNAME).id,
					username: SUPERADMIN_USERNAME,
					passwordHash: await Bun.password.hash(SUPERADMIN_PASSWORD),
				}
			: undefined,
		publicUrl: PUBLIC_URL,
		maxAgeSeconds: 8 * 3600,
		idleTimeoutSeconds: 3600,
		sessions: createUiSessionStore(db),
		access,
	});
};

beforeAll(async () => {
	db = openMainDatabase(':memory:');
	uiAuth = await createAuth();
	routes = uiAuth.routes as unknown as Routes;
});

afterEach(() => {
	setSystemTime();
	db.run('DELETE FROM ui_sessions');
});

afterAll(async () => {
	db.close();
	await idp.stop(true);
});

const call = (
	path: string,
	method: string,
	init: RequestInit & { url?: string; clientIp?: string; on?: Routes } = {},
) => {
	const handler = (init.on ?? routes)[path]?.[method];
	if (!handler) throw new Error(`No ${method} ${path}`);
	return handler(
		new Request(init.url ?? `${PUBLIC_URL}${path}`, {
			...init,
			method,
		}),
		{
			requestIP: () => ({
				address: init.clientIp ?? '192.0.2.1',
			}),
		},
	);
};

const cookiesOf = (response: Response) =>
	Object.fromEntries(
		response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(';')[0]?.split('=') ?? []),
	);

// Run the whole login: start, IdP approval with the given claims, callback.
const logIn = async (
	claims: Record<string, unknown>,
	returnTo = '/ui/debug',
) => {
	const start = await call(AUTH_PATHS.login, 'GET', {
		url: `${PUBLIC_URL}${AUTH_PATHS.login}?returnTo=${encodeURIComponent(returnTo)}`,
	});
	expect(start.status).toBe(302);
	const authorization = new URL(start.headers.get('location') ?? '');
	const loginCookie = start.headers.getSetCookie()[0] ?? '';
	const code = crypto.randomUUID();
	codes.set(code, {
		claims,
		challenge: authorization.searchParams.get('code_challenge') ?? '',
		nonce: authorization.searchParams.get('nonce') ?? '',
	});
	const callback = await call(AUTH_PATHS.callback, 'GET', {
		url: `${PUBLIC_URL}${AUTH_PATHS.callback}?code=${code}&state=${authorization.searchParams.get('state')}`,
		headers: {
			Cookie: loginCookie.split(';')[0] ?? '',
		},
	});
	return {
		authorization,
		loginCookie,
		callback,
		session: cookiesOf(callback).mcpx_session as string | undefined,
	};
};

const sessionCall = (session: string | undefined, on?: Routes) =>
	call(AUTH_PATHS.session, 'GET', {
		on,
		headers: session
			? {
					Cookie: `mcpx_session=${session}`,
				}
			: {},
	});

it('an admin logs in with code flow and PKCE and gets a session', async () => {
	const { authorization, loginCookie, callback, session } = await logIn({
		sub: 'user-1',
		name: 'Ada Admin',
		preferred_username: 'ada',
		[ROLES_CLAIM]: ['admin'],
	});
	expect(authorization.origin + authorization.pathname).toBe(
		`${issuer}/authorize`,
	);
	expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
		client_id: CLIENT_ID,
		response_type: 'code',
		redirect_uri: `${PUBLIC_URL}${AUTH_PATHS.callback}`,
		scope: 'openid profile email',
		code_challenge_method: 'S256',
	});
	expect(loginCookie).toContain(`Path=${AUTH_PATHS.callback}`);
	expect(loginCookie).toContain('HttpOnly');
	expect(loginCookie).toContain('Secure');
	expect(callback.status).toBe(302);
	expect(callback.headers.get('location')).toBe(`${PUBLIC_URL}/ui/debug`);
	const sessionCookie =
		callback.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith('mcpx_session=')) ?? '';
	for (const attribute of [
		'Path=/',
		'Max-Age=28800',
		'HttpOnly',
		'Secure',
		'SameSite=Lax',
	])
		expect(sessionCookie).toContain(attribute);
	expect(session).toBeString();
	expect(await (await sessionCall(session)).json()).toEqual({
		name: 'Ada Admin',
	});
	const [stored] = db
		.query<{ claims: string }, []>('SELECT claims FROM ui_sessions')
		.all();
	expect(JSON.parse(stored?.claims ?? '')).toMatchObject({
		sub: 'user-1',
		iss: issuer,
	});
});

it('roles may be an object keyed by role, and only admins get a session', async () => {
	const keyed = await logIn({
		sub: 'user-2',
		[ROLES_CLAIM]: {
			admin: {
				org: 'example',
			},
		},
	});
	expect((await sessionCall(keyed.session)).status).toBe(200);
	const info = spyOn(logger, 'info');
	const warn = spyOn(logger, 'warn');
	for (const roles of [['viewer'], undefined, 'admin']) {
		const refused = await logIn({
			sub: 'user-3',
			[ROLES_CLAIM]: roles,
		});
		expect(refused.callback.status).toBe(403);
		expect(refused.session).toBeUndefined();
	}
	expect(warn.mock.calls[0]?.[0]).toBe(
		'Auth refused: flow=oidc_login user_id=user-3 reason="none of its roles is in ADMIN_ROLES"',
	);
	// Roles and claim names show why: here the roles claim is missing.
	expect(
		info.mock.calls
			.map(([line]) => line)
			.filter((line) =>
				String(line).startsWith('Auth: flow=oidc_login user_id=user-3 '),
			)[1],
	).toBe(
		`Auth: flow=oidc_login user_id=user-3 app_client_id=${CLIENT_ID} service_account_client_id=none key_id=none client_ip=none roles=[] roles_claim=roles scopes_granted=none claims=[iat,exp,iss,aud,nonce,sub]`,
	);
	info.mockRestore();
	warn.mockRestore();
});

it('only dashboard pages are returned to after the login', async () => {
	for (const [returnTo, expected] of [
		['/ui/debug/', '/ui/debug'],
		['https://evil.example/ui', '/ui'],
		['//evil.example', '/ui'],
		['/api/overview', '/ui'],
	] as const) {
		const { callback } = await logIn(
			{
				sub: 'user-1',
				[ROLES_CLAIM]: ['admin'],
			},
			returnTo,
		);
		expect(callback.headers.get('location')).toBe(`${PUBLIC_URL}${expected}`);
	}
});

it('a login started on another host moves to PUBLIC_URL first', async () => {
	const response = await call(AUTH_PATHS.login, 'GET', {
		url: `http://127.0.0.1:4567${AUTH_PATHS.login}?returnTo=%2Fui`,
	});
	expect(response.status).toBe(302);
	expect(response.headers.get('location')).toBe(
		`${PUBLIC_URL}${AUTH_PATHS.login}?returnTo=%2Fui`,
	);
	expect(response.headers.getSetCookie()).toEqual([]);
});

it('a callback without its login cookie, or replayed, is refused', async () => {
	const { authorization, loginCookie } = await logIn({
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	});
	for (const cookie of [undefined, loginCookie.split(';')[0]]) {
		const response = await call(AUTH_PATHS.callback, 'GET', {
			url: `${PUBLIC_URL}${AUTH_PATHS.callback}?code=x&state=${authorization.searchParams.get('state')}`,
			headers: cookie
				? {
						Cookie: cookie,
					}
				: {},
		});
		expect(response.status).toBe(400);
	}
});

it('an IdP error answer fails the login with 400', async () => {
	const start = await call(AUTH_PATHS.login, 'GET');
	const state = new URL(start.headers.get('location') ?? '').searchParams.get(
		'state',
	);
	const response = await call(AUTH_PATHS.callback, 'GET', {
		url: `${PUBLIC_URL}${AUTH_PATHS.callback}?error=access_denied&state=${state}`,
		headers: {
			Cookie: start.headers.getSetCookie()[0]?.split(';')[0] ?? '',
		},
	});
	expect(response.status).toBe(400);
	expect(cookiesOf(response).mcpx_session).toBeUndefined();
});

it('sessions end after the idle timeout or the maximum age', async () => {
	const start = Date.now();
	setSystemTime(start);
	const admin = {
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	};
	const idle = (await logIn(admin)).session;
	setSystemTime(start + 3599_000);
	expect((await sessionCall(idle)).status).toBe(200);
	setSystemTime(start + 3599_000 + 3599_000);
	expect((await sessionCall(idle)).status).toBe(200);
	setSystemTime(start + 3599_000 * 3 + 2000);
	expect((await sessionCall(idle)).status).toBe(401);

	setSystemTime(start);
	const used = (await logIn(admin)).session;
	for (let hour = 1; hour < 8; hour += 1) {
		setSystemTime(start + hour * 3500_000);
		expect((await sessionCall(used)).status).toBe(200);
	}
	setSystemTime(start + 8 * 3600_000);
	expect((await sessionCall(used)).status).toBe(401);
	expect(db.query('SELECT * FROM ui_sessions').all()).toEqual([]);
});

it('the login access token survives a restart, stored encrypted', async () => {
	const { session } = await logIn({
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	});
	const request = (cookie: string) =>
		new Request(`${PUBLIC_URL}/api/tester/mcp`, {
			headers: {
				Cookie: `mcpx_session=${cookie}`,
			},
		});
	expect(await uiAuth.accessToken(request(session ?? ''))).toBe('access');
	const stored = db
		.query<{ tokens: string }, []>('SELECT tokens FROM ui_sessions')
		.get()?.tokens;
	expect(stored).toBeString();
	expect(stored).not.toContain('access');
	// A new instance on the same database stands in for a gateway restart.
	const restarted = await createAuth();
	expect(await restarted.accessToken(request(session ?? ''))).toBe('access');
	expect(await restarted.accessToken(request('unknown'))).toBeUndefined();
});

it('parallel requests refresh an expired login token once and keep the rotated refresh token', async () => {
	const { session = '' } = await logIn({
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	});
	const store = createUiSessionStore(db);
	const request = () =>
		new Request(`${PUBLIC_URL}/api/tester/mcp`, {
			headers: {
				Cookie: `mcpx_session=${session}`,
			},
		});
	const parallel = () =>
		Promise.all(
			Array.from(
				{
					length: 5,
				},
				() => uiAuth.accessToken(request()),
			),
		);
	refreshToken = 'refresh-0';
	await store.saveTokens(session, {
		accessToken: 'expired',
		refreshToken,
		expiresAt: 0,
	});
	const before = refreshes;
	const fresh = `access-${before + 1}`;
	expect(await parallel()).toEqual([fresh, fresh, fresh, fresh, fresh]);
	expect(refreshes - before).toBe(1);
	expect((await store.findTokens(session))?.refreshToken).toBe(refreshToken);
	// A failed refresh is shared too, but not kept: the next request tries again.
	await store.saveTokens(session, {
		accessToken: 'expired',
		refreshToken: 'revoked',
		expiresAt: 0,
	});
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	expect(await parallel()).toEqual([
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	]);
	expect(refreshes - before).toBe(2);
	expect(await uiAuth.accessToken(request())).toBeUndefined();
	expect(refreshes - before).toBe(3);
	warn.mockRestore();
});

it('a login adds its user and roles, and the session shows the user label', async () => {
	const { session } = await logIn({
		sub: 'user-9',
		name: 'Nine',
		preferred_username: 'nine',
		[ROLES_CLAIM]: ['admin', 'ops'],
	});
	const access = createAccessStore(db);
	const user = access.findUser('user-9');
	expect([user?.name, user?.username]).toEqual(['Nine', 'nine']);
	expect(access.listRoles().map((role) => role.name)).toEqual(['admin', 'ops']);
	expect(user?.roleIds).toHaveLength(2);
	expect(user?.idpRoles).toEqual(['admin', 'ops']);
	// The next login follows the IdP: a dropped role is unassigned.
	await logIn({
		sub: 'user-9',
		preferred_username: 'nine',
		[ROLES_CLAIM]: ['admin'],
	});
	expect(access.findUser('user-9')?.roleIds).toEqual(
		access
			.listRoles()
			.filter((role) => role.name === 'admin')
			.map((role) => role.id),
	);
	access.saveUser({
		id: 'user-9',
		name: 'renamed',
		enabled: true,
	});
	expect(await (await sessionCall(session)).json()).toEqual({
		name: 'renamed',
	});
	// Without a Name, the user shows by its user ID.
	access.saveUser({
		id: 'user-9',
		enabled: true,
	});
	expect(await (await sessionCall(session)).json()).toEqual({
		name: 'user-9',
	});
	db.run('DELETE FROM users');
	db.run('DELETE FROM roles');
});

it('logout deletes the session and returns the IdP logout URL', async () => {
	const { session } = await logIn({
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	});
	const response = await call(AUTH_PATHS.logout, 'POST', {
		headers: {
			Origin: PUBLIC_URL,
			Cookie: `mcpx_session=${session}`,
		},
	});
	expect(response.status).toBe(200);
	const { logoutUrl } = (await response.json()) as { logoutUrl: string };
	const url = new URL(logoutUrl);
	expect(url.origin + url.pathname).toBe(`${issuer}/logout`);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		client_id: CLIENT_ID,
		post_logout_redirect_uri: `${PUBLIC_URL}/ui`,
	});
	expect(cookiesOf(response).mcpx_session).toBe('');
	expect((await sessionCall(session)).status).toBe(401);
});

it('protected routes need a session, and non-GET ones an Origin equal to PUBLIC_URL', async () => {
	const { session } = await logIn({
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	});
	const protectedRoutes = uiAuth.protect({
		'/api/thing': {
			GET: (_request: Request) => new Response('read'),
			POST: (_request: Request) => new Response('written'),
		},
	});
	const request = (method: 'GET' | 'POST', headers: Record<string, string>) =>
		protectedRoutes['/api/thing'][method](
			new Request(`${PUBLIC_URL}/api/thing`, {
				method,
				headers,
			}),
		);
	const cookie = `mcpx_session=${session}`;
	expect((await request('GET', {})).status).toBe(401);
	expect((await request('GET', { Cookie: 'mcpx_session=wrong' })).status).toBe(
		401,
	);
	expect(await (await request('GET', { Cookie: cookie })).text()).toBe('read');
	for (const origin of [undefined, 'https://evil.example', 'http://mcpx.test'])
		expect(
			(
				await request('POST', {
					Cookie: cookie,
					...(origin
						? {
								Origin: origin,
							}
						: {}),
				})
			).status,
		).toBe(403);
	expect(
		await (
			await request('POST', { Cookie: cookie, Origin: PUBLIC_URL })
		).text(),
	).toBe('written');
	expect(
		(
			await call(AUTH_PATHS.logout, 'POST', {
				headers: {
					Origin: 'https://evil.example',
				},
			})
		).status,
	).toBe(403);
});

// The Auth tab deletes or disables a user; then the same ID signs in again
// on /mcp, without an admin role, before the old cookie is used.
it('deleting or disabling an admin ends its sessions, even if it comes back', async () => {
	const access = createAccessStore(db);
	const accessRoutes = createAccessRoutes(access, uiAuth);
	const change = (path: 'deleteUser' | 'saveUser', body: unknown) =>
		accessRoutes[ACCESS_PATHS[path]].POST(
			new Request(`${PUBLIC_URL}${ACCESS_PATHS[path]}`, {
				method: 'POST',
				body: JSON.stringify(body),
			}),
		);
	const protectedRoutes = uiAuth.protect({
		'/api/thing': {
			GET: (_request: Request) => new Response('read'),
		},
	});
	const get = (session: string | undefined) =>
		protectedRoutes['/api/thing'].GET(
			new Request(`${PUBLIC_URL}/api/thing`, {
				headers: {
					Cookie: `mcpx_session=${session}`,
				},
			}),
		);
	const claims = {
		sub: 'user-7',
		[ROLES_CLAIM]: ['admin'],
	};
	const comeBack = () =>
		access.signIn(
			{
				id: 'user-7',
				roles: [],
			},
			Date.now(),
		);
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	try {
		const deleted = (await logIn(claims)).session;
		expect((await get(deleted)).status).toBe(200);
		expect(
			(
				await change('deleteUser', {
					id: 'user-7',
				})
			).status,
		).toBe(200);
		comeBack();
		expect((await get(deleted)).status).toBe(401);

		const disabled = (await logIn(claims)).session;
		const other = (
			await logIn({
				sub: 'user-8',
				[ROLES_CLAIM]: ['admin'],
			})
		).session;
		const save = (enabled: boolean) =>
			change('saveUser', {
				id: 'user-7',
				enabled,
			});
		expect((await save(false)).status).toBe(200);
		expect((await save(true)).status).toBe(200);
		expect((await get(disabled)).status).toBe(401);
		expect((await get(other)).status).toBe(200);
		expect(
			info.mock.calls
				.map(([line]) => String(line))
				.filter((line) => line.includes('ended_sessions')),
		).toEqual([
			'Auth admin: op=delete_user admin_id=none user_id=user-7 ended_sessions=1',
			'Auth admin: op=save_user admin_id=none user_id=user-7 realm=oidc type=human created=false enabled=false ended_sessions=1',
		]);
	} finally {
		info.mockRestore();
	}
});

it('the login check of an event stream is not a use, and fails once the session ends', async () => {
	const access = createAccessStore(db);
	const start = Date.now();
	setSystemTime(start);
	const admin = {
		sub: 'user-1',
		[ROLES_CLAIM]: ['admin'],
	};
	const loggedIn = (session: string | undefined) =>
		uiAuth.isLoggedIn(
			new Request(`${PUBLIC_URL}/api/events`, {
				headers: {
					Cookie: `mcpx_session=${session}`,
				},
			}),
		);
	const lastUsed = () =>
		db
			.query<{ last_used_at: number }, []>(
				'SELECT last_used_at FROM ui_sessions',
			)
			.get()?.last_used_at;
	// Idle: checks alone do not keep the session.
	const idle = (await logIn(admin)).session;
	setSystemTime(start + 3599_000);
	expect(loggedIn(idle)).toBe(true);
	expect(lastUsed()).toBe(start);
	setSystemTime(start + 3600_000);
	expect(loggedIn(idle)).toBe(false);
	// Maximum age, though the session is in use.
	setSystemTime(start);
	const used = (await logIn(admin)).session;
	for (let hour = 1; hour < 8; hour += 1) {
		setSystemTime(start + hour * 3500_000);
		expect((await sessionCall(used)).status).toBe(200);
	}
	expect(loggedIn(used)).toBe(true);
	setSystemTime(start + 8 * 3600_000);
	expect(loggedIn(used)).toBe(false);
	setSystemTime();
	// Logout.
	const out = (await logIn(admin)).session;
	await call(AUTH_PATHS.logout, 'POST', {
		headers: {
			Origin: PUBLIC_URL,
			Cookie: `mcpx_session=${out}`,
		},
	});
	expect(loggedIn(out)).toBe(false);
	// A disabled or deleted user.
	const disabled = (await logIn(admin)).session;
	access.saveUser({
		id: 'user-1',
		enabled: false,
	});
	expect(loggedIn(disabled)).toBe(false);
	access.saveUser({
		id: 'user-1',
		enabled: true,
	});
	const deleted = (await logIn(admin)).session;
	expect(loggedIn(deleted)).toBe(true);
	access.deleteUser('user-1');
	expect(loggedIn(deleted)).toBe(false);
	expect(db.query('SELECT * FROM ui_sessions').all()).toEqual([]);
});

it('startup removes expired sessions and those from another issuer, client, deleted user or without an admin role', () => {
	const store = createUiSessionStore(db);
	const now = Date.now();
	createAccessStore(db).signIn(
		{
			id: 'user-1',
			roles: ['admin'],
		},
		now,
	);
	const add = (
		fields: Partial<Parameters<typeof store.create>[0]> = {},
	): string =>
		store.create({
			issuer,
			clientId: CLIENT_ID,
			claims: {
				sub: 'user-1',
				[ROLES_CLAIM]: ['admin'],
			},
			createdAt: now,
			...fields,
		}).sessionId;
	const kept = add();
	add({
		createdAt: now - 2 * 3600_000,
	});
	add({
		issuer: 'https://other.example',
	});
	add({
		clientId: 'another-client',
	});
	add({
		claims: {
			sub: 'user-2',
			[ROLES_CLAIM]: ['viewer'],
		},
	});
	add({
		claims: {
			sub: 'deleted-user',
			[ROLES_CLAIM]: ['admin'],
		},
	});
	// A superadmin session, while the superadmin is off.
	add({
		issuer: 'local',
		clientId: '',
		claims: {
			sub: 'superadmin-id',
		},
	});
	expect(uiAuth.removeInvalidSessions()).toBe(6);
	expect(store.list()).toHaveLength(1);
	expect(store.find(kept)).toBeDefined();
});

const passwordLogin = (
	on: Routes,
	body: Record<string, unknown>,
	clientIp?: string,
) =>
	call(AUTH_PATHS.password, 'POST', {
		on,
		clientIp,
		headers: {
			Origin: PUBLIC_URL,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

it('the superadmin logs in with its password, beside OIDC', async () => {
	const both = await createAuth({
		superadmin: true,
	});
	const on = both.routes as unknown as Routes;
	expect(await (await call(AUTH_PATHS.methods, 'GET', { on })).json()).toEqual({
		oidc: true,
		password: true,
		publicUrl: PUBLIC_URL,
	});
	const info = spyOn(logger, 'info');
	const response = await passwordLogin(on, {
		username: SUPERADMIN_USERNAME,
		password: SUPERADMIN_PASSWORD,
		returnTo: '/ui/debug',
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		returnTo: '/ui/debug',
	});
	const signIn = String(
		info.mock.calls.find(([line]) =>
			String(line).startsWith('Auth: flow=password_login'),
		)?.[0],
	);
	info.mockRestore();
	expect(signIn).toContain('client_ip=192.0.2.1');
	expect(signIn).not.toContain(SUPERADMIN_PASSWORD);
	const session = cookiesOf(response).mcpx_session;
	expect(await (await sessionCall(session, on)).json()).toEqual({
		name: SUPERADMIN_USERNAME,
	});
	const request = new Request(`${PUBLIC_URL}/api/tester/mcp`, {
		headers: {
			Cookie: `mcpx_session=${session}`,
		},
	});
	const superadminId = createAccessStore(db)
		.listUsers()
		.find((user) => user.superadmin)?.id;
	expect(both.superadminIdOf(request)).toBe(superadminId);
	expect(both.adminIdOf(request)).toBe(superadminId);
	expect(await both.accessToken(request)).toBeUndefined();
	// The superadmin's logout stays at the gateway.
	const logout = await call(AUTH_PATHS.logout, 'POST', {
		on,
		headers: {
			Origin: PUBLIC_URL,
			Cookie: `mcpx_session=${session}`,
		},
	});
	expect(await logout.json()).toEqual({
		logoutUrl: `${PUBLIC_URL}/ui`,
	});
	// Another origin cannot log in.
	expect(
		(
			await call(AUTH_PATHS.password, 'POST', {
				on,
				headers: {
					Origin: 'https://evil.example',
				},
				body: JSON.stringify({
					username: SUPERADMIN_USERNAME,
					password: SUPERADMIN_PASSWORD,
				}),
			})
		).status,
	).toBe(403);
});

it('failed password logins are limited per client address', async () => {
	const on = (
		await createAuth({
			oidc: false,
			superadmin: true,
		})
	).routes as unknown as Routes;
	expect(await (await call(AUTH_PATHS.methods, 'GET', { on })).json()).toEqual({
		oidc: false,
		password: true,
		publicUrl: PUBLIC_URL,
	});
	expect(on[AUTH_PATHS.login]).toBeUndefined();
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	for (const body of [
		{
			username: SUPERADMIN_USERNAME,
			password: 'wrong',
		},
		{
			username: 'other',
			password: SUPERADMIN_PASSWORD,
		},
		{
			username: SUPERADMIN_USERNAME.toUpperCase(),
			password: SUPERADMIN_PASSWORD,
		},
		{
			username: '',
			password: '',
		},
		{
			username: SUPERADMIN_USERNAME,
			password: `${SUPERADMIN_PASSWORD} `,
		},
	])
		expect((await passwordLogin(on, body, '198.51.100.7')).status).toBe(401);
	const right = {
		username: SUPERADMIN_USERNAME,
		password: SUPERADMIN_PASSWORD,
	};
	expect((await passwordLogin(on, right, '198.51.100.7')).status).toBe(429);
	expect(warn.mock.calls.at(-1)?.[0]).toBe(
		'Auth refused: flow=password_login client_ip=198.51.100.7 reason="too many failed logins"',
	);
	warn.mockRestore();
	// Other addresses still log in, and the limit ends with its window.
	expect((await passwordLogin(on, right, '198.51.100.8')).status).toBe(200);
	setSystemTime(Date.now() + 15 * 60_000);
	expect((await passwordLogin(on, right, '198.51.100.7')).status).toBe(200);
});

it('without the superadmin, there is no password login', async () => {
	expect(routes[AUTH_PATHS.password]).toBeUndefined();
	expect(await (await call(AUTH_PATHS.methods, 'GET')).json()).toEqual({
		oidc: true,
		password: false,
		publicUrl: PUBLIC_URL,
	});
});

it('parallel password attempts share the failure limit', async () => {
	const on = (
		await createAuth({
			oidc: false,
			superadmin: true,
		})
	).routes as unknown as Routes;
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const attempts = await Promise.all(
		Array.from(
			{
				length: 8,
			},
			() =>
				passwordLogin(
					on,
					{
						username: SUPERADMIN_USERNAME,
						password: 'wrong',
					},
					'203.0.113.9',
				),
		),
	);
	expect(
		attempts.map((response) => response.status).toSorted((a, b) => a - b),
	).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
	expect(
		(
			await passwordLogin(
				on,
				{
					username: SUPERADMIN_USERNAME,
					password: SUPERADMIN_PASSWORD,
				},
				'203.0.113.9',
			)
		).status,
	).toBe(429);
	warn.mockRestore();
});

it('disabled and Local users cannot log in, and their roles stay', async () => {
	const access = createAccessStore(db);
	access.saveUser({
		id: 'user-5',
		enabled: false,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const claims = {
		sub: 'user-5',
		name: 'Five',
		[ROLES_CLAIM]: ['admin'],
	};
	const refused = await logIn(claims);
	expect(refused.callback.status).toBe(403);
	expect(await refused.callback.json()).toEqual({
		error: 'This user is disabled.',
	});
	expect(refused.session).toBeUndefined();
	expect(warn.mock.calls.at(-1)?.[0]).toBe(
		'Auth refused: flow=oidc_login user_id=user-5 reason="user is disabled"',
	);
	expect(access.findUser('user-5')).toMatchObject({
		name: undefined,
		roleIds: [],
		idpRoles: [],
		lastSeenAt: undefined,
	});
	// Enabled again, the user logs in like /mcp signs in: last seen now.
	access.saveUser({
		id: 'user-5',
		enabled: true,
	});
	const enabled = await logIn(claims);
	expect(enabled.callback.status).toBe(302);
	expect(access.findUser('user-5')).toMatchObject({
		name: 'Five',
		idpRoles: ['admin'],
		lastSeenAt: expect.any(Number),
	});
	// Disabled again, its session ends at once.
	access.saveUser({
		id: 'user-5',
		enabled: false,
	});
	expect((await sessionCall(enabled.session)).status).toBe(401);
	expect(db.query('SELECT * FROM ui_sessions').all()).toHaveLength(0);
	// An IdP user ID that is a Local user's is refused, and the user unchanged.
	const localId = access.saveUser({
		id: '',
		name: 'Local bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	const local = await logIn({
		sub: localId,
		name: 'Impostor',
		[ROLES_CLAIM]: ['admin'],
	});
	expect(local.callback.status).toBe(403);
	expect(access.findUser(localId)).toMatchObject({
		name: 'Local bot',
		idpRoles: [],
	});
	warn.mockRestore();
	db.run('DELETE FROM users');
	db.run('DELETE FROM roles');
});

it('a protected request looks its session up once and its handler gets the user', async () => {
	const access = createAccessStore(db);
	const sessions = createUiSessionStore(db);
	const auth = createUiAuth({
		superadmin: {
			userId: access.ensureSuperadmin(SUPERADMIN_USERNAME).id,
			username: SUPERADMIN_USERNAME,
			passwordHash: await Bun.password.hash(SUPERADMIN_PASSWORD),
		},
		publicUrl: PUBLIC_URL,
		maxAgeSeconds: 8 * 3600,
		idleTimeoutSeconds: 3600,
		sessions,
		access,
	});
	const login = await passwordLogin(auth.routes as unknown as Routes, {
		username: SUPERADMIN_USERNAME,
		password: SUPERADMIN_PASSWORD,
	});
	const find = spyOn(sessions, 'find');
	const protectedRoutes = auth.protect({
		'/api/thing': {
			POST: async (request: Request) =>
				Response.json({
					admin: auth.adminIdOf(request),
					superadmin: auth.superadminIdOf(request),
					token: (await auth.accessToken(request)) ?? null,
				}),
		},
	});
	const response = await protectedRoutes['/api/thing'].POST(
		new Request(`${PUBLIC_URL}/api/thing`, {
			method: 'POST',
			headers: {
				Origin: PUBLIC_URL,
				Cookie: `mcpx_session=${cookiesOf(login).mcpx_session}`,
			},
		}),
	);
	const superadminId = access.listUsers().find((user) => user.superadmin)?.id;
	expect(await response.json()).toEqual({
		admin: superadminId,
		superadmin: superadminId,
		token: null,
	});
	expect(find).toHaveBeenCalledTimes(1);
});
