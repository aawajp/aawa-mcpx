import { type } from 'arktype';
import * as client from 'openid-client';

import { timingSafeEqual } from 'node:crypto';

import {
	isDue,
	logRefusal,
	logSignIn,
	profileOf,
	rolesOf,
} from '@/server/auth/identity';
import type { AccessStore } from '@/server/db/access';
import type {
	LoginTokens,
	UiSession,
	UiSessionStore,
} from '@/server/db/ui_sessions';
import { guardRoutes } from '@/server/gateway/allowed_hosts';
import { jsonError, readBody } from '@/server/gateway/http';
import { logFields, logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import {
	AUTH_PATHS,
	RETURN_TO_PARAM,
	UI_PAGE_PATHS,
	userLabel,
} from '@/shared/ui_api';

const SESSION_COOKIE = 'mcpx_session';
const LOGIN_COOKIE = 'mcpx_login';
const LOGIN_TIMEOUT_SECONDS = 600;
// Login starts need no session, so their pending state is capped; beyond it
// the oldest pending login is dropped.
const MAX_PENDING_LOGINS = 100;
// Failed password logins per client address within the window; beyond it,
// logins are refused until the window ends.
const PASSWORD_FAILURE_LIMIT = 5;
const PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000;
// The issuer of sessions the superadmin's password login creates.
const LOCAL_ISSUER = 'local';

type PendingLogin = {
	codeVerifier: string;
	state: string;
	nonce: string;
	returnTo: string;
	expiresAt: number;
};

type UiOidcParams = {
	config: client.Configuration;
	clientId: string;
	scopes: readonly string[];
	rolesClaim: string;
	adminRoles: readonly string[];
};

type UiSuperadminParams = {
	// The superadmin's Local user.
	userId: string;
	username: string;
	passwordHash: string;
};

// At least one login method: OIDC for admins, or the superadmin's password.
type UiAuthParams = {
	publicUrl: string;
	maxAgeSeconds: number;
	idleTimeoutSeconds: number;
	sessions: UiSessionStore;
	access: AccessStore;
	oidc?: UiOidcParams;
	superadmin?: UiSuperadminParams;
};

// The logged-in user of a dashboard request: the superadmin by password, or
// an admin by OIDC. The session ID from the cookie keys the session's tokens.
type UiPrincipal = {
	userId: string;
	method: 'oidc' | 'password';
	sessionId: string;
	session: UiSession;
};

const passwordLoginType = type({
	'+': 'reject',
	username: 'string',
	password: 'string',
	'returnTo?': 'string',
});

const cookieValue = (request: Request, name: string): string | undefined =>
	new Bun.CookieMap(request.headers.get('cookie') ?? '').get(name) ?? undefined;

const createUiAuth = (params: UiAuthParams) => {
	const {
		access,
		idleTimeoutSeconds,
		maxAgeSeconds,
		oidc,
		publicUrl,
		sessions,
		superadmin,
	} = params;
	const issuer = oidc?.config.serverMetadata().issuer;
	const publicHost = new URL(publicUrl).host;
	const pendingLogins = new Map<string, PendingLogin>();
	// Failed password logins by client address.
	const passwordFailures = new Map<
		string,
		{ count: number; resetAt: number }
	>();
	// Token lookups in flight, by session ID: parallel requests share one, so
	// an expired token is refreshed once and a rotated refresh token is saved
	// before any of them reads it.
	const tokenLookups = new Map<string, Promise<LoginTokens | undefined>>();
	// Each request's principal, so its handlers do not read the cookie and the
	// session again; an entry lasts only as long as its request.
	const principals = new WeakMap<Request, UiPrincipal>();

	const keepTokens = async (
		sessionId: string,
		tokens: client.TokenEndpointResponse,
		refreshToken?: string,
	): Promise<LoginTokens> => {
		const kept: LoginTokens = {
			accessToken: tokens.access_token,
			expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
		};
		const refresh = tokens.refresh_token ?? refreshToken;
		if (refresh) kept.refreshToken = refresh;
		await sessions.saveTokens(sessionId, kept);
		return kept;
	};

	const cookie = (name: string, value: string, maxAge: number, path = '/') =>
		new Bun.Cookie(name, value, {
			path,
			maxAge,
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
		}).serialize();

	const isAdmin = (claims: Record<string, unknown>) =>
		oidc !== undefined &&
		rolesOf(claims, oidc.rolesClaim).some((role) =>
			oidc.adminRoles.includes(role),
		);

	// A session that has not expired, of a login method that is on, for a user
	// who may still log in: the superadmin, or an admin of this issuer and
	// client who exists and is enabled.
	const isValid = (session: UiSession, now: number) =>
		now - session.createdAt < maxAgeSeconds * 1000 &&
		now - session.lastUsedAt < idleTimeoutSeconds * 1000 &&
		(session.issuer === LOCAL_ISSUER
			? superadmin !== undefined && session.claims.sub === superadmin.userId
			: oidc !== undefined &&
				session.issuer === issuer &&
				session.clientId === oidc.clientId &&
				isAdmin(session.claims) &&
				access.findUser(String(session.claims.sub))?.enabled === true);

	// The session the ID names, if it is still valid; an invalid one is
	// deleted, so disabling or deleting a user ends its sessions at once.
	const validSession = (
		sessionId: string,
		now: number,
	): UiSession | undefined => {
		const session = sessions.find(sessionId);
		if (!session || isValid(session, now)) return session;
		sessions.delete(session.idHash);
		return undefined;
	};

	// The user of the request's valid session, looked up once per request. The
	// request uses the session: it counts as activity for the idle timeout.
	const principalOf = (request: Request): UiPrincipal | undefined => {
		const known = principals.get(request);
		if (known) return known;
		const sessionId = cookieValue(request, SESSION_COOKIE);
		if (sessionId === undefined) return undefined;
		const now = Date.now();
		const session = validSession(sessionId, now);
		if (!session) return undefined;
		if (isDue(session.lastUsedAt, now)) sessions.touch(session.idHash, now);
		const principal: UiPrincipal = {
			userId: String(session.claims.sub),
			method: session.issuer === LOCAL_ISSUER ? 'password' : 'oidc',
			sessionId,
			session,
		};
		principals.set(request, principal);
		return principal;
	};

	// Delete every session that is no longer valid.
	const removeInvalidSessions = (): number => {
		const now = Date.now();
		const invalid = sessions.list().filter((session) => !isValid(session, now));
		for (const session of invalid) sessions.delete(session.idHash);
		return invalid.length;
	};

	// Only the dashboard pages can be returned to after the login.
	const returnPath = (value: string | null | undefined): string => {
		const path = value?.replace(/(.)\/$/, '$1');
		return (
			Object.values(UI_PAGE_PATHS).find(
				(page) => page === path && page !== UI_PAGE_PATHS.login,
			) ?? UI_PAGE_PATHS.main
		);
	};

	// A new session, after the invalid ones are removed.
	const startSession = (
		session: Omit<UiSession, 'idHash' | 'lastUsedAt'>,
	): string => {
		removeInvalidSessions();
		return sessions.create(session).sessionId;
	};

	const methods = (): Response =>
		Response.json({
			oidc: oidc !== undefined,
			password: superadmin !== undefined,
			publicUrl,
		});

	const oidcLogin =
		(login: UiOidcParams) =>
		async (request: Request): Promise<Response> => {
			const url = new URL(request.url);
			// The login cookie must be set on the host the IdP returns to.
			if (url.host !== publicHost)
				return Response.redirect(
					new URL(url.pathname + url.search, publicUrl).href,
					302,
				);
			const codeVerifier = client.randomPKCECodeVerifier();
			const pending: PendingLogin = {
				codeVerifier,
				state: client.randomState(),
				nonce: client.randomNonce(),
				returnTo: returnPath(url.searchParams.get(RETURN_TO_PARAM)),
				expiresAt: Date.now() + LOGIN_TIMEOUT_SECONDS * 1000,
			};
			const loginId = client.randomState();
			pendingLogins.set(loginId, pending);
			for (const id of pendingLogins.keys()) {
				if (pendingLogins.size <= MAX_PENDING_LOGINS) break;
				pendingLogins.delete(id);
			}
			const authorizationUrl = client.buildAuthorizationUrl(login.config, {
				redirect_uri: new URL(AUTH_PATHS.callback, publicUrl).href,
				scope: login.scopes.join(' '),
				code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
				code_challenge_method: 'S256',
				state: pending.state,
				nonce: pending.nonce,
			});
			return new Response(null, {
				status: 302,
				headers: {
					Location: authorizationUrl.href,
					'Set-Cookie': cookie(
						LOGIN_COOKIE,
						loginId,
						LOGIN_TIMEOUT_SECONDS,
						AUTH_PATHS.callback,
					),
				},
			});
		};

	const oidcCallback =
		(login: UiOidcParams) =>
		async (request: Request): Promise<Response> => {
			const loginId = cookieValue(request, LOGIN_COOKIE);
			const pending =
				loginId === undefined ? undefined : pendingLogins.get(loginId);
			if (loginId !== undefined) pendingLogins.delete(loginId);
			if (!pending || pending.expiresAt <= Date.now())
				return jsonError(
					400,
					'The login expired or was started in another browser. Open the dashboard again.',
				);
			const url = new URL(request.url);
			let claims: Record<string, unknown>;
			let tokens: client.TokenEndpointResponse;
			try {
				const response = await client.authorizationCodeGrant(
					login.config,
					// The IdP redirected to PUBLIC_URL; behind a proxy request.url differs.
					new URL(url.pathname + url.search, publicUrl),
					{
						pkceCodeVerifier: pending.codeVerifier,
						expectedState: pending.state,
						expectedNonce: pending.nonce,
					},
				);
				claims = response.claims() ?? {};
				tokens = response;
			} catch (error) {
				logRefusal({
					flow: 'oidc_login',
					reason: errorMessage(error),
				});
				return jsonError(
					error instanceof client.AuthorizationResponseError ? 400 : 502,
					`Login failed: ${errorMessage(error)}`,
				);
			}
			const subject = String(claims.sub);
			const roles = rolesOf(claims, login.rolesClaim);
			logSignIn({
				flow: 'oidc_login',
				userId: subject,
				appClientId: login.clientId,
				roles,
				rolesClaim: login.rolesClaim,
				scope: tokens.scope,
				claimNames: Object.keys(claims),
			});
			if (!isAdmin(claims)) {
				logRefusal({
					flow: 'oidc_login',
					user_id: subject,
					reason: 'none of its roles is in ADMIN_ROLES',
				});
				return jsonError(403, 'Only admins can use the dashboard.');
			}
			const now = Date.now();
			// As on /mcp: Local users log in only at the gateway, and disabled
			// users not at all.
			const user = access.signIn(
				{
					id: subject,
					...profileOf(claims),
					roles,
				},
				now,
			);
			if (user.realm !== 'oidc' || !user.enabled) {
				logRefusal({
					flow: 'oidc_login',
					user_id: subject,
					reason: user.enabled ? 'Local user' : 'user is disabled',
				});
				return jsonError(
					403,
					user.enabled
						? 'This user ID belongs to a Local user.'
						: 'This user is disabled.',
				);
			}
			const sessionId = startSession({
				issuer: issuer ?? '',
				clientId: login.clientId,
				claims,
				createdAt: now,
			});
			await keepTokens(sessionId, tokens);
			const headers = new Headers({
				Location: new URL(pending.returnTo, publicUrl).href,
			});
			headers.append(
				'Set-Cookie',
				cookie(SESSION_COOKIE, sessionId, maxAgeSeconds),
			);
			headers.append(
				'Set-Cookie',
				cookie(LOGIN_COOKIE, '', 0, AUTH_PATHS.callback),
			);
			return new Response(null, {
				status: 302,
				headers,
			});
		};

	// Compared as SHA-256 digests in constant time, like the password, so the
	// answer's timing tells neither whether the username was right nor its
	// length.
	const sameText = (a: string, b: string) => {
		const digest = (text: string) =>
			new Bun.CryptoHasher('sha256').update(text).digest();
		return timingSafeEqual(digest(a), digest(b));
	};

	const passwordLogin =
		(login: UiSuperadminParams) =>
		async (request: Request, server: Bun.Server<undefined>) => {
			const clientIp = server.requestIP(request)?.address ?? 'unknown';
			const now = Date.now();
			for (const [ip, entry] of passwordFailures)
				if (entry.resetAt <= now) passwordFailures.delete(ip);
			const failures = passwordFailures.get(clientIp) ?? {
				count: 0,
				resetAt: now + PASSWORD_FAILURE_WINDOW_MS,
			};
			if (failures.count >= PASSWORD_FAILURE_LIMIT) {
				logRefusal({
					flow: 'password_login',
					client_ip: clientIp,
					reason: 'too many failed logins',
				});
				return jsonError(429, 'Too many failed logins. Try again later.');
			}
			// Counted before the awaits, so parallel attempts share the limit;
			// a login clears it.
			failures.count += 1;
			passwordFailures.set(clientIp, failures);
			const body = await readBody(passwordLoginType, request);
			if (body instanceof Response) return body;
			const passwordMatches = await Bun.password.verify(
				body.password,
				login.passwordHash,
			);
			if (!(sameText(body.username, login.username) && passwordMatches)) {
				logRefusal({
					flow: 'password_login',
					client_ip: clientIp,
					reason: 'wrong username or password',
				});
				return jsonError(401, 'Wrong username or password.');
			}
			passwordFailures.delete(clientIp);
			logSignIn({
				flow: 'password_login',
				userId: login.userId,
				clientIp,
				roles: [],
				claimNames: [],
			});
			const sessionId = startSession({
				issuer: LOCAL_ISSUER,
				clientId: '',
				claims: {
					sub: login.userId,
				},
				createdAt: now,
			});
			return Response.json(
				{
					returnTo: returnPath(body.returnTo),
				},
				{
					headers: {
						'Set-Cookie': cookie(SESSION_COOKIE, sessionId, maxAgeSeconds),
					},
				},
			);
		};

	const logout = (request: Request): Response => {
		const principal = principalOf(request);
		if (principal) sessions.delete(principal.session.idHash);
		const afterLogout = new URL(UI_PAGE_PATHS.main, publicUrl).href;
		const endSession = oidc?.config.serverMetadata().end_session_endpoint;
		const logoutUrl =
			oidc && endSession && principal?.method !== 'password'
				? client.buildEndSessionUrl(oidc.config, {
						post_logout_redirect_uri: afterLogout,
					}).href
				: afterLogout;
		return Response.json(
			{
				logoutUrl,
			},
			{
				headers: {
					'Set-Cookie': cookie(SESSION_COOKIE, '', 0),
				},
			},
		);
	};

	// The session's tokens, refreshed when they have expired and the IdP gave
	// a refresh token.
	const freshTokens = async (
		login: UiOidcParams,
		sessionId: string,
	): Promise<LoginTokens | undefined> => {
		const tokens = await sessions.findTokens(sessionId);
		if (!tokens || tokens.expiresAt > Date.now() || !tokens.refreshToken)
			return tokens;
		return keepTokens(
			sessionId,
			await client.refreshTokenGrant(login.config, tokens.refreshToken),
			tokens.refreshToken,
		);
	};

	// The logged-in admin's access token. The superadmin has none.
	const accessToken = async (request: Request): Promise<string | undefined> => {
		if (!oidc) return undefined;
		const principal = principalOf(request);
		if (!principal) return undefined;
		const { sessionId } = principal;
		try {
			let lookup = tokenLookups.get(sessionId);
			if (!lookup) {
				lookup = freshTokens(oidc, sessionId).finally(() =>
					tokenLookups.delete(sessionId),
				);
				tokenLookups.set(sessionId, lookup);
			}
			return (await lookup)?.accessToken;
		} catch (error) {
			logger.warn(
				`Auth sync failed: ${logFields({
					op: 'use_login_token',
					admin_id: principal.userId,
					error: errorMessage(error),
				})}`,
			);
			return undefined;
		}
	};

	// The logged-in admin's user ID, for logs.
	const adminIdOf = (request: Request): string | undefined =>
		principalOf(request)?.userId;

	// The superadmin's user ID, when the superadmin is logged in: the Tester
	// then signs requests as the superadmin, who has no access token.
	const superadminIdOf = (request: Request): string | undefined => {
		const principal = principalOf(request);
		return principal?.method === 'password' ? principal.userId : undefined;
	};

	const sessionInfo = (request: Request): Response => {
		const principal = principalOf(request);
		if (!principal) return jsonError(401, 'Login required.');
		const id = principal.userId;
		return Response.json({
			name: userLabel(
				access.findUser(id) ?? {
					id,
					...profileOf(principal.session.claims),
				},
			),
		});
	};

	// Browsers send Origin on every non-GET request; other origins are refused
	// so another site cannot act with the session cookie.
	const isSameOrigin = (request: Request): boolean =>
		request.method === 'GET' ||
		request.method === 'HEAD' ||
		request.headers.get('origin') === publicUrl;
	const originForbidden = () =>
		jsonError(403, 'Origin does not match PUBLIC_URL.');

	// Require a valid session (401 otherwise) and, for non-GET requests, an
	// Origin equal to PUBLIC_URL (403 otherwise). The handlers get the
	// request's principal from `adminIdOf`, `superadminIdOf` and `accessToken`
	// without another lookup.
	const protect = <T extends Parameters<typeof guardRoutes>[0]>(routes: T): T =>
		guardRoutes(
			guardRoutes(
				routes,
				(request) => principalOf(request) !== undefined,
				() => jsonError(401, 'Login required.'),
			),
			isSameOrigin,
			originForbidden,
		);

	const routes = {
		[AUTH_PATHS.methods]: {
			GET: methods,
		},
		...guardRoutes(
			{
				...(oidc
					? {
							[AUTH_PATHS.login]: {
								GET: oidcLogin(oidc),
							},
							[AUTH_PATHS.callback]: {
								GET: oidcCallback(oidc),
							},
						}
					: {}),
				...(superadmin
					? {
							[AUTH_PATHS.password]: {
								POST: passwordLogin(superadmin),
							},
						}
					: {}),
				[AUTH_PATHS.logout]: {
					POST: logout,
				},
			},
			isSameOrigin,
			originForbidden,
		),
		...protect({
			[AUTH_PATHS.session]: {
				GET: sessionInfo,
			},
		}),
	};

	return {
		routes,
		protect,
		removeInvalidSessions,
		// Whether the request's session is still valid, without using it; an
		// open event stream checks this on each update.
		isLoggedIn: (request: Request): boolean => {
			const sessionId = cookieValue(request, SESSION_COOKIE);
			return (
				sessionId !== undefined &&
				validSession(sessionId, Date.now()) !== undefined
			);
		},
		// Ends the user's sessions at once, when it is deleted or disabled, so
		// a user added again with the same ID never inherits them.
		endSessions: (userId: string): number => sessions.deleteForUser(userId),
		accessToken,
		adminIdOf,
		superadminIdOf,
	};
};

type UiAuth = ReturnType<typeof createUiAuth>;

export type { UiAuth };
export { createUiAuth };
