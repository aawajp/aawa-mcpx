import { discoverIssuer } from '@/server/auth/identity';
import { jwks, signJwt } from '@/server/auth/idp_fixture';
import { createMcpAuth, type McpPrincipal } from '@/server/auth/mcp_auth';
import {
	type AccessStore,
	apiKeyHash,
	createAccessStore,
} from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { logger } from '@/server/logger';
import { KEY_HINT_LENGTH, LOCAL_KEY_PREFIX } from '@/shared/ui_api';

import {
	afterAll,
	beforeAll,
	expect,
	it,
	setSystemTime,
	spyOn,
} from 'bun:test';

const PUBLIC_URL = 'https://mcpx.test';
const AUDIENCE = 'mcpx-project';
const SERVICE_ID = 'build-bot';
const SERVICE_SECRET = 'bot-secret';
const SERVICE_TOKEN = 'opaque-service-token';

// A local OpenID provider: JWKS for signed access tokens, a token endpoint
// for the client credentials grant and a UserInfo endpoint for its token.
let tokenRequests = 0;
let tokenScope = '';
// A test holds the token answer until it releases it.
let tokenHeld: { arrived: () => void; release: Promise<void> } | undefined;
let displayToken = '';

let issuer: string;
const idp = Bun.serve({
	port: 0,
	routes: {
		'/.well-known/openid-configuration': () =>
			Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				userinfo_endpoint: `${issuer}/userinfo`,
				jwks_uri: `${issuer}/jwks`,
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
			}),
		'/jwks': () => Response.json(jwks),
		'/token': {
			async POST(request) {
				tokenRequests += 1;
				tokenHeld?.arrived();
				await tokenHeld?.release;
				const body = new URLSearchParams(await request.text());
				tokenScope = body.get('scope') ?? '';
				const [id, secret] = atob(
					request.headers.get('authorization')?.replace(/^Basic /, '') ?? '',
				)
					.split(':')
					.map(decodeURIComponent);
				// IdP failures, with an OAuth error body and without.
				if (id === 'broken-bot')
					return Response.json(
						{
							error: 'server_error',
						},
						{
							status: 500,
						},
					);
				if (id === 'down-bot')
					return new Response('Service Unavailable', {
						status: 503,
					});
				if (
					body.get('grant_type') !== 'client_credentials' ||
					id !== SERVICE_ID ||
					secret !== SERVICE_SECRET
				)
					return Response.json(
						{
							error: 'invalid_client',
						},
						{
							status: 400,
						},
					);
				return Response.json({
					access_token: SERVICE_TOKEN,
					token_type: 'Bearer',
					expires_in: 300,
				});
			},
		},
		'/userinfo': (request) => {
			const authorization = request.headers.get('authorization');
			if (authorization === `Bearer ${SERVICE_TOKEN}`)
				return Response.json({
					sub: 'service-subject',
					roles: {
						ops: {},
					},
				});
			// UserInfo gives the names of one OAuth user.
			if (authorization === `Bearer ${displayToken}`)
				return Response.json({
					sub: 'display-subject',
					name: 'Display Name',
					preferred_username: 'display-login',
				});
			return new Response(null, {
				status: 401,
			});
		},
	},
});
issuer = `http://127.0.0.1:${idp.port}`;

const signToken = (claims: Record<string, unknown>) =>
	signJwt({
		iss: issuer,
		aud: [AUDIENCE, 'native-app'],
		...claims,
	});

const db = openMainDatabase(':memory:');
const access = createAccessStore(db);
let auth: ReturnType<typeof createMcpAuth>;
const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);

const createAuth = async (store: AccessStore) =>
	createMcpAuth({
		access: store,
		oidc: {
			config: await discoverIssuer(
				new URL(issuer),
				'gateway',
				'gateway-secret',
			),
			publicUrl: PUBLIC_URL,
			audience: AUDIENCE,
			scopes: ['openid', 'project-roles'],
			rolesClaim: 'roles',
		},
	});

beforeAll(async () => {
	auth = await createAuth(access);
});

afterAll(() => {
	warning.mockRestore();
	db.close();
	idp.stop();
});

// An OIDC service account's API key, as the dashboard builds it.
const apiKey = (id: string, secret: string) =>
	`sk_aawa_api01_${Buffer.from(`${id}:${secret}`).toString('base64url')}`;

// Registers an API key as the dashboard does: its hash and last characters.
const register = (userId: string, key: string, store = access) =>
	store.registerKey({
		userId,
		label: 'test',
		hash: apiKeyHash(key),
		hint: key.slice(-KEY_HINT_LENGTH),
	});

const authenticate = (authorization?: string, on = auth) =>
	on.authenticate(
		new Request(`${PUBLIC_URL}/mcp`, {
			method: 'POST',
			headers: authorization
				? {
						Authorization: authorization,
					}
				: {},
		}),
	);

const status = async (authorization?: string, on = auth) => {
	const result = await authenticate(authorization, on);
	return result instanceof Response ? result.status : 200;
};

it('OAuth access tokens and client credentials map to users by user ID', async () => {
	const ops = access.saveRole({
		name: 'ops',
		userIds: [],
	});
	const alice = 'alice-subject';
	access.saveUser({
		id: alice,
		name: 'alice',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	access.saveUser({
		id: 'service-subject',
		name: 'build-bot',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	access.saveUser({
		id: 'carol-subject',
		enabled: false,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	// Names left empty in the dashboard are filled from the user's tokens.
	access.saveUser({
		id: 'display-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	access.savePermissions(
		{
			holderType: 'role',
			holderId: ops,
		},
		[
			{
				backend: 'alpha',
				tool: 'deploy',
			},
		],
	);
	access.savePermissions(
		{
			holderType: 'user',
			holderId: alice,
		},
		[
			{
				backend: 'alpha',
				tool: '',
			},
		],
	);

	const missing = await authenticate();
	expect(missing).toBeInstanceOf(Response);
	expect((missing as Response).status).toBe(401);
	expect((missing as Response).headers.get('WWW-Authenticate')).toBe(
		`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
	);

	// Role membership comes from the token's roles claim, matched by name.
	// A set Name stays; the empty Username is filled from the token.
	const principal = (await authenticate(
		`Bearer ${await signToken({
			sub: 'alice-subject',
			name: 'Alice Token',
			preferred_username: 'alice-login',
			roles: ['ops', 'unknown'],
		})}`,
	)) as McpPrincipal;
	expect(principal.userId).toBe(alice);
	expect(principal.access.allowsTool('alpha', 'deploy')).toBe(true);
	expect(principal.access.allowsTool('alpha', 'other')).toBe(false);
	expect(principal.access.allowsBackend('alpha')).toBe(true);
	const seen = access.listUsers().find((user) => user.id === alice);
	expect(seen?.lastSeenAt).toBeNumber();
	expect(seen?.idpRoles).toEqual(['ops', 'unknown']);
	expect([seen?.name, seen?.username]).toEqual(['alice', 'alice-login']);
	// A role assigned only in the dashboard stays when tokens drop roles.
	const manual = access.saveRole({
		name: 'manual',
		userIds: [alice],
	});
	const withoutRole = (await authenticate(
		`Bearer ${await signToken({
			sub: 'alice-subject',
		})}`,
	)) as McpPrincipal;
	// A token without the role unassigns it.
	expect(withoutRole.access.allowsTool('alpha', 'deploy')).toBe(false);
	const after = access.listUsers().find((user) => user.id === alice);
	expect(after?.idpRoles).toEqual([]);
	expect(after?.roleIds).toEqual([manual]);

	expect(
		await status(
			`Bearer ${await signToken({
				sub: 'alice-subject',
				aud: 'other',
			})}`,
		),
	).toBe(401);
	expect(
		await status(
			`Bearer ${await signToken({
				sub: 'alice-subject',
				exp: Math.floor(Date.now() / 1000) - 60,
			})}`,
		),
	).toBe(401);
	// A token must expire.
	expect(
		await status(
			`Bearer ${await signToken({
				sub: 'alice-subject',
				exp: undefined,
			})}`,
		),
	).toBe(401);
	// An unknown user ID becomes a user without permissions, named from the
	// token, and its unknown roles become roles. Names need not be unique.
	const newcomer = (await authenticate(
		`Bearer ${await signToken({
			sub: 'newcomer-subject',
			name: 'Newcomer',
			preferred_username: 'alice-login',
			roles: ['auditors'],
		})}`,
	)) as McpPrincipal;
	expect(newcomer.userId).toBe('newcomer-subject');
	expect(newcomer.access.allowsBackend('alpha')).toBe(false);
	expect(access.listRoles().map((role) => role.name)).toContain('auditors');
	const added = access.findUser('newcomer-subject');
	expect([added?.name, added?.username, added?.enabled]).toEqual([
		'Newcomer',
		'alice-login',
		true,
	]);
	expect(
		await status(
			`Bearer ${await signToken({
				sub: 'carol-subject',
			})}`,
		),
	).toBe(403);
	// Names the token lacks come from UserInfo.
	displayToken = await signToken({
		sub: 'display-subject',
	});
	expect(await status(`Bearer ${displayToken}`)).toBe(200);
	const display = access.findUser('display-subject');
	expect([display?.name, display?.username]).toEqual([
		'Display Name',
		'display-login',
	]);

	const key = apiKey(SERVICE_ID, SERVICE_SECRET);
	// Only keys registered in the dashboard sign in; no IdP request is made.
	expect(await status(`Bearer ${key}`)).toBe(401);
	expect(tokenRequests).toBe(0);
	const registered = register('service-subject', key);
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	const bot = (await authenticate(`Bearer ${key}`)) as McpPrincipal;
	expect(bot.userId).toBe('service-subject');
	// The sign-in line names the service account and the key, never the secret.
	const signIn = String(
		info.mock.calls.find(([line]) => String(line).startsWith('Auth: '))?.[0],
	);
	info.mockRestore();
	expect(signIn).toStartWith(
		`Auth: flow=oidc_api_key user_id=service-subject app_client_id=none service_account_client_id=${SERVICE_ID} key_id=${registered.id} client_ip=none roles=[`,
	);
	expect(signIn).not.toContain(SERVICE_SECRET);
	// UserInfo gives the roles as an object keyed by role.
	expect(bot.access.allowsTool('alpha', 'deploy')).toBe(true);
	expect(((await authenticate(`Bearer ${key}`)) as McpPrincipal).userId).toBe(
		'service-subject',
	);
	expect(tokenRequests).toBe(1);
	expect(tokenScope).toBe('openid project-roles');
	expect(
		access.listKeys().find((entry) => entry.id === registered.id)?.lastUsedAt,
	).toBeNumber();
	// Revoking takes effect at once, though the exchanged token is cached.
	access.deleteKey(registered.id);
	expect(await status(`Bearer ${key}`)).toBe(401);
	// A key the IdP refuses, or one registered for another user.
	const wrong = apiKey(SERVICE_ID, 'wrong');
	register('service-subject', wrong);
	expect(await status(`Bearer ${wrong}`)).toBe(401);
	access.saveUser({
		id: 'other-account',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	register('other-account', key);
	expect(await status(`Bearer ${key}`)).toBe(401);
	const malformed = 'sk_aawa_api01_bm8tY29sb24';
	register('service-subject', malformed);
	expect(await status(`Bearer ${malformed}`)).toBe(401);
	expect(await status(`Basic ${btoa(`${SERVICE_ID}:${SERVICE_SECRET}`)}`)).toBe(
		401,
	);
	expect(await status('Digest whatever')).toBe(401);
});

it('Local users sign in with their own API keys, and the Tester as any user', async () => {
	const localId = access.saveUser({
		id: '',
		name: 'Local bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	expect(localId).not.toBe('');
	access.savePermissions(
		{
			holderType: 'user',
			holderId: localId,
		},
		[
			{
				backend: 'gamma',
				tool: '',
			},
		],
	);
	expect(await status(`Bearer ${LOCAL_KEY_PREFIX}unknown`)).toBe(401);
	const { key, apiKey: registered } = access.createKey({
		userId: localId,
		label: 'test',
	});
	const local = (await authenticate(`Bearer ${key}`)) as McpPrincipal;
	expect(local.userId).toBe(localId);
	expect(local.access.allowsBackend('gamma')).toBe(true);
	expect(access.findUser(localId)?.lastSeenAt).toBeNumber();
	// A token for the Local user's ID is refused.
	expect(
		await status(
			`Bearer ${await signToken({
				sub: localId,
			})}`,
		),
	).toBe(401);
	// A disabled Local user is known but refused.
	access.saveUser({
		id: localId,
		name: 'Local bot',
		enabled: false,
	});
	expect(await status(`Bearer ${key}`)).toBe(403);
	access.deleteKey(registered.id);
	expect(await status(`Bearer ${key}`)).toBe(401);

	// The Tester's request carries no credentials.
	const request = new Request(`${PUBLIC_URL}/mcp`, {
		method: 'POST',
	});
	auth.signTesterRequest(request, 'alice-subject');
	expect(((await auth.authenticate(request)) as McpPrincipal).userId).toBe(
		'alice-subject',
	);
	auth.signTesterRequest(request, localId);
	expect(await auth.authenticate(request)).toBeInstanceOf(Response);
	// The superadmin, too, though it has no credentials for /mcp.
	const superadminId = access.ensureSuperadmin('root').id;
	auth.signTesterRequest(request, superadminId);
	expect(((await auth.authenticate(request)) as McpPrincipal).userId).toBe(
		superadminId,
	);
});

it('an API key is exchanged once per IdP token, and signs in once per touch interval', async () => {
	const store = createAccessStore(openMainDatabase(':memory:'));
	const fresh = await createAuth(store);
	store.saveUser({
		id: 'service-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	const key = apiKey(SERVICE_ID, SERVICE_SECRET);
	register('service-subject', key, store);
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	const signIns = () =>
		info.mock.calls.filter(([line]) => String(line).startsWith('Auth: '))
			.length;
	const exchanges = tokenRequests;
	const start = Date.now();
	for (let request = 0; request < 3; request += 1)
		expect(await status(`Bearer ${key}`, fresh)).toBe(200);
	expect([tokenRequests - exchanges, signIns()]).toEqual([1, 1]);
	// The cached exchange signs in again after the touch interval.
	setSystemTime(start + 61_000);
	expect(await status(`Bearer ${key}`, fresh)).toBe(200);
	expect([tokenRequests - exchanges, signIns()]).toEqual([1, 2]);
	// The IdP token expires after 300 seconds.
	setSystemTime(start + 301_000);
	expect(await status(`Bearer ${key}`, fresh)).toBe(200);
	expect([tokenRequests - exchanges, signIns()]).toEqual([2, 3]);
	setSystemTime();
	info.mockRestore();
});

it('parallel requests with one API key share its exchange, and a failed one is not kept', async () => {
	const store = createAccessStore(openMainDatabase(':memory:'));
	const fresh = await createAuth(store);
	store.saveUser({
		id: 'service-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	const parallel = (key: string) =>
		Promise.all(
			Array.from(
				{
					length: 5,
				},
				() => status(`Bearer ${key}`, fresh),
			),
		);
	const key = apiKey(SERVICE_ID, SERVICE_SECRET);
	register('service-subject', key, store);
	const down = apiKey('down-bot', 'secret');
	register('service-subject', down, store);
	const exchanges = tokenRequests;
	expect(await parallel(key)).toEqual([200, 200, 200, 200, 200]);
	expect(tokenRequests - exchanges).toBe(1);
	expect(await parallel(down)).toEqual([502, 502, 502, 502, 502]);
	expect(tokenRequests - exchanges).toBe(2);
	expect(await status(`Bearer ${down}`, fresh)).toBe(502);
	expect(tokenRequests - exchanges).toBe(3);
});

it('an API key revoked while the IdP answers is refused', async () => {
	const store = createAccessStore(openMainDatabase(':memory:'));
	const fresh = await createAuth(store);
	store.saveUser({
		id: 'service-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	const key = apiKey(SERVICE_ID, SERVICE_SECRET);
	const registered = register('service-subject', key, store);
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	tokenHeld = {
		arrived: arrived.resolve,
		release: release.promise,
	};
	try {
		const waiting = Promise.all([
			status(`Bearer ${key}`, fresh),
			status(`Bearer ${key}`, fresh),
		]);
		await arrived.promise;
		store.deleteKey(registered.id);
		release.resolve();
		expect(await waiting).toEqual([401, 401]);
	} finally {
		// A failure above must not leave the IdP's answer held.
		release.resolve();
		tokenHeld = undefined;
	}
});

it('an IdP failure during the key exchange answers 502', async () => {
	const store = createAccessStore(openMainDatabase(':memory:'));
	const fresh = await createAuth(store);
	store.saveUser({
		id: 'service-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	for (const id of ['broken-bot', 'down-bot']) {
		const key = apiKey(id, 'secret');
		register('service-subject', key, store);
		expect(await status(`Bearer ${key}`, fresh)).toBe(502);
	}
	// The IdP refusing the credentials is a 401.
	const wrong = apiKey(SERVICE_ID, 'wrong');
	register('service-subject', wrong, store);
	expect(await status(`Bearer ${wrong}`, fresh)).toBe(401);
});

it('without OIDC, only Local API keys sign in', async () => {
	const localOnly = createMcpAuth({
		access,
	});
	expect(localOnly.routes).toEqual({});
	const localId = access.saveUser({
		id: '',
		name: 'Offline bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	const { key } = access.createKey({
		userId: localId,
		label: 'test',
	});
	const authenticateWith = (authorization: string) =>
		localOnly.authenticate(
			new Request(`${PUBLIC_URL}/mcp`, {
				method: 'POST',
				headers: {
					Authorization: authorization,
				},
			}),
		);
	expect(
		((await authenticateWith(`Bearer ${key}`)) as McpPrincipal).userId,
	).toBe(localId);
	const refused = (await authenticateWith(
		`Bearer ${await signToken({
			sub: 'alice-subject',
		})}`,
	)) as Response;
	expect(refused.status).toBe(401);
	// No resource metadata to point MCP clients to.
	expect(refused.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
});

it('resource metadata names the gateway and the issuer', async () => {
	const response =
		auth.routes['/.well-known/oauth-protected-resource/mcp']?.GET();
	expect(await response?.json()).toEqual({
		resource: `${PUBLIC_URL}/mcp`,
		authorization_servers: [issuer],
		scopes_supported: ['openid', 'project-roles'],
		bearer_methods_supported: ['header'],
		resource_name: 'aawa-mcpx',
	});
});
