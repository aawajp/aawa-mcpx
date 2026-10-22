import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import * as client from 'openid-client';

import {
	isDue,
	issuerClient,
	logRefusal,
	logSignIn,
	profileOf,
	rolesOf,
	type SignIn,
	type SignInFlow,
} from '@/server/auth/identity';
import {
	type Access,
	type AccessStore,
	type AccessUser,
	apiKeyHash,
} from '@/server/db/access';
import { rpcError } from '@/server/gateway/json_rpc';
import { logFields, logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import { RPC_ERROR } from '@/shared/mcp_protocol';
import { LOCAL_KEY_PREFIX, OIDC_KEY_PREFIX } from '@/shared/ui_api';

// RFC 9728 metadata for the /mcp resource; MCP clients find it through the
// 401 challenge or at these well-known paths.
const RESOURCE_METADATA_PATHS = [
	'/.well-known/oauth-protected-resource/mcp',
	'/.well-known/oauth-protected-resource',
] as const;
// Without expires_in, an exchanged client credential is trusted this long.
const DEFAULT_TOKEN_SECONDS = 300;

// The authenticated user behind an /mcp request.
type McpPrincipal = {
	userId: string;
	access: Access;
};

type McpOidcParams = {
	config: client.Configuration;
	publicUrl: string;
	audience: string;
	// OIDC_SCOPES: what MCP clients and API keys request, as the dashboard does.
	scopes: readonly string[];
	rolesClaim: string;
};

type McpAuthParams = {
	access: AccessStore;
	// Without it (ENABLE_OIDC=false), only Local API keys sign in.
	oidc?: McpOidcParams;
};

// Who the IdP says the client is: its user ID, names and roles.
type Identity = {
	id: string;
	name?: string;
	username?: string;
	roles: string[];
};

// Credentials the IdP vouches for: who they sign in, what the sign-in line
// tells about them, and an OAuth access token for UserInfo (API keys already
// used it).
type Verified = {
	identity: Identity;
	signIn: Omit<SignIn, 'userId' | 'roles'>;
	accessToken?: string;
};

// The OIDC settings with the IdP's metadata and signing keys.
const idpOf = (oidc: McpOidcParams) => {
	const metadata = oidc.config.serverMetadata();
	return {
		...oidc,
		metadata,
		jwks: createRemoteJWKSet(new URL(String(metadata.jwks_uri))),
	};
};

type Idp = ReturnType<typeof idpOf>;

const createMcpAuth = ({ access, oidc }: McpAuthParams) => {
	const idp = oidc && idpOf(oidc);
	const resourceMetadataUrl = idp
		? new URL(RESOURCE_METADATA_PATHS[0], idp.publicUrl).href
		: undefined;
	// Exchanged OIDC service account keys, by key hash.
	const exchanged = new Map<string, Verified & { expiresAt: number }>();
	// Key exchanges in flight, by key hash: parallel requests share one.
	const exchanges = new Map<string, Promise<Verified>>();
	// Requests the dashboard Tester sends as the superadmin, who has no token;
	// only code in this process can add one.
	const testerRequests = new WeakMap<Request, string>();

	const refuse = (
		status: 401 | 403 | 502,
		message: string,
		tokenError?: string,
	): Response => {
		const headers = new Headers({
			'Content-Type': 'application/json',
		});
		if (status === 401) {
			const challenge = [
				resourceMetadataUrl && `resource_metadata="${resourceMetadataUrl}"`,
				tokenError && `error="${tokenError}"`,
			]
				.filter(Boolean)
				.join(', ');
			headers.set(
				'WWW-Authenticate',
				challenge ? `Bearer ${challenge}` : 'Bearer',
			);
		}
		return new Response(
			JSON.stringify(rpcError(undefined, RPC_ERROR.InvalidRequest, message)),
			{
				status,
				headers,
			},
		);
	};

	// The user may use /mcp when known and enabled: 403 otherwise.
	const admit = (
		flow: SignInFlow,
		userId: string,
		user: AccessUser | undefined,
	): McpPrincipal | Response => {
		if (!user?.enabled) {
			logRefusal({
				flow,
				user_id: userId,
				reason: user ? 'user is disabled' : 'unknown user',
			});
			return refuse(403, user ? 'User is disabled' : 'Unknown user');
		}
		return {
			userId,
			access: access.accessOf(userId),
		};
	};

	// An OAuth access token: a JWT from OIDC_ISSUER for OIDC_AUDIENCE.
	const verifyToken = async (
		idp: Idp,
		token: string,
	): Promise<Verified | Response> => {
		try {
			const { payload } = await jwtVerify(token, idp.jwks, {
				issuer: idp.metadata.issuer,
				audience: idp.audience,
				requiredClaims: ['exp', 'sub'],
			});
			if (typeof payload.sub !== 'string')
				throw new Error('The token has no subject');
			return {
				identity: {
					id: payload.sub,
					...profileOf(payload),
					roles: rolesOf(payload, idp.rolesClaim),
				},
				signIn: {
					flow: 'oauth_access_token',
					// RFC 9068 names the app in client_id; OIDC tokens in azp.
					appClientId: [payload.client_id, payload.azp].find(
						(value) => typeof value === 'string',
					) as string | undefined,
					rolesClaim: idp.rolesClaim,
					scope: typeof payload.scope === 'string' ? payload.scope : undefined,
					claimNames: Object.keys(payload),
				},
				accessToken: token,
			};
		} catch (error) {
			logRefusal({
				flow: 'oauth_access_token',
				reason: errorMessage(error),
			});
			return refuse(401, 'Invalid access token', 'invalid_token');
		}
	};

	// An OIDC service account key's client ID and secret are exchanged for a
	// token with the client credentials grant; the IdP's UserInfo names the
	// subject. Roles come from UserInfo and, when the token is a JWT, from the
	// token itself; it came straight from the token endpoint, so it is only
	// decoded. The result is kept until that token expires.
	const exchangeKey = async (
		idp: Idp,
		key: { id: string; hash: string },
		clientId: string,
		clientSecret: string,
	): Promise<Verified> => {
		const now = Date.now();
		exchanged.delete(key.hash);
		const config = issuerClient(idp.metadata, clientId, clientSecret);
		const tokens = await client.clientCredentialsGrant(config, {
			scope: idp.scopes.join(' '),
		});
		const userInfo = await client.fetchUserInfo(
			config,
			tokens.access_token,
			client.skipSubjectCheck,
		);
		let tokenClaims: Record<string, unknown> = {};
		try {
			tokenClaims = decodeJwt(tokens.access_token);
		} catch {
			// An opaque token: UserInfo alone gives the roles.
		}
		const fromUserInfo = profileOf(userInfo);
		const fromToken = profileOf(tokenClaims);
		const verified: Verified = {
			identity: {
				id: userInfo.sub,
				name: fromUserInfo.name ?? fromToken.name,
				username: fromUserInfo.username ?? fromToken.username,
				roles: [
					...new Set([
						...rolesOf(userInfo, idp.rolesClaim),
						...rolesOf(tokenClaims, idp.rolesClaim),
					]),
				],
			},
			signIn: {
				flow: 'oidc_api_key',
				serviceAccountClientId: clientId,
				keyId: key.id,
				rolesClaim: idp.rolesClaim,
				scope: tokens.scope,
				claimNames: new Set([
					...Object.keys(userInfo),
					...Object.keys(tokenClaims),
				]),
			},
		};
		for (const [entryKey, entry] of exchanged)
			if (entry.expiresAt <= now) exchanged.delete(entryKey);
		exchanged.set(key.hash, {
			...verified,
			expiresAt: now + (tokens.expires_in ?? DEFAULT_TOKEN_SECONDS) * 1000,
		});
		return verified;
	};

	// The key's kept exchange, or a new one; a failed exchange is not kept.
	const exchangedKey = (
		idp: Idp,
		key: { id: string; hash: string },
		clientId: string,
		clientSecret: string,
	): Promise<Verified> => {
		const cached = exchanged.get(key.hash);
		if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
		let exchange = exchanges.get(key.hash);
		if (!exchange) {
			exchange = exchangeKey(idp, key, clientId, clientSecret).finally(() =>
				exchanges.delete(key.hash),
			);
			exchanges.set(key.hash, exchange);
		}
		return exchange;
	};

	// An OIDC service account key. Only keys registered in the dashboard sign
	// in, so revoking one takes effect at once.
	const verifyKey = async (
		idp: Idp,
		value: string,
	): Promise<Verified | Response> => {
		const hash = apiKeyHash(value);
		const key = access.findKey(hash);
		if (key?.user.realm !== 'oidc')
			return refuse(401, 'Unknown API key', 'invalid_token');
		const decoded = Buffer.from(
			value.slice(OIDC_KEY_PREFIX.length),
			'base64url',
		).toString('utf8');
		const colon = decoded.indexOf(':');
		if (colon < 1) return refuse(401, 'Malformed API key', 'invalid_token');
		let verified: Verified;
		try {
			verified = await exchangedKey(
				idp,
				{
					id: key.id,
					hash,
				},
				decoded.slice(0, colon),
				decoded.slice(colon + 1),
			);
		} catch (error) {
			logRefusal({
				flow: 'oidc_api_key',
				key_id: key.id,
				reason: errorMessage(error),
			});
			// An OAuth error answer means the IdP refused the credentials.
			return error instanceof client.ResponseBodyError ||
				error instanceof client.WWWAuthenticateChallengeError
				? refuse(401, 'Invalid API key', 'invalid_token')
				: refuse(
						502,
						`Identity provider request failed: ${errorMessage(error)}`,
					);
		}
		// The key may have been revoked while the IdP answered.
		if (access.findKey(hash)?.id !== key.id)
			return refuse(401, 'Unknown API key', 'invalid_token');
		if (verified.identity.id !== key.userId) {
			logRefusal({
				flow: 'oidc_api_key',
				user_id: verified.identity.id,
				key_id: key.id,
				reason: `the key is registered for user ${key.userId}`,
			});
			return refuse(401, 'Invalid API key', 'invalid_token');
		}
		const now = Date.now();
		if (isDue(key.lastUsedAt, now)) access.touchKey(key.id, now);
		return verified;
	};

	// Access tokens usually lack the profile claims, so a user's empty names
	// come from UserInfo.
	const userInfoProfile = async (idp: Idp, userId: string, token: string) => {
		try {
			return profileOf(
				await client.fetchUserInfo(idp.config, token, client.skipSubjectCheck),
			);
		} catch (error) {
			logger.info(
				`Auth sync failed: ${logFields({
					op: 'fetch_userinfo',
					user_id: userId,
					error: errorMessage(error),
				})}`,
			);
			return {};
		}
	};

	// Credentials the IdP vouches for sign their user in once per touch
	// interval or roles change: logged, and the user added or updated by the
	// store. In between, the stored user answers.
	const signInVerified = async (
		idp: Idp,
		{ identity, signIn, accessToken }: Verified,
	): Promise<McpPrincipal | Response> => {
		const now = Date.now();
		const known = access.findUser(identity.id);
		// Local users sign in only with their own API keys.
		if (known?.realm === 'local') {
			logRefusal({
				flow: signIn.flow,
				user_id: identity.id,
				reason: 'Local user',
			});
			return refuse(401, 'Invalid access token', 'invalid_token');
		}
		const due =
			!known ||
			isDue(known.lastSeenAt, now) ||
			JSON.stringify(identity.roles) !== JSON.stringify(known.idpRoles);
		if (!due) return admit(signIn.flow, identity.id, known);
		logSignIn({
			...signIn,
			userId: identity.id,
			roles: identity.roles,
		});
		let named = identity;
		if (
			accessToken &&
			known?.enabled !== false &&
			(!(known?.name || identity.name) ||
				!(known?.username || identity.username))
		) {
			const profile = await userInfoProfile(idp, identity.id, accessToken);
			named = {
				...identity,
				name: identity.name ?? profile.name,
				username: identity.username ?? profile.username,
			};
		}
		return admit(signIn.flow, identity.id, access.signIn(named, now));
	};

	// A Local user's API key: known by its hash alone.
	const authenticateLocalKey = (value: string): McpPrincipal | Response => {
		const key = access.findKey(apiKeyHash(value));
		if (key?.user.realm !== 'local')
			return refuse(401, 'Unknown API key', 'invalid_token');
		const now = Date.now();
		if (isDue(key.lastUsedAt, now)) access.touchKey(key.id, now);
		if (isDue(key.user.lastSeenAt, now)) {
			logSignIn({
				flow: 'local_api_key',
				userId: key.user.id,
				keyId: key.id,
				roles: [],
				claimNames: [],
			});
			if (key.user.enabled) access.touchUser(key.user.id, now);
		}
		return admit('local_api_key', key.user.id, key.user);
	};

	// The request's user, or the response refusing it: 401 without valid
	// credentials, 403 for an unknown or disabled user.
	const authenticate = async (
		request: Request,
	): Promise<McpPrincipal | Response> => {
		const testerUser = testerRequests.get(request);
		if (testerUser !== undefined)
			return admit('tester', testerUser, access.findUser(testerUser));
		const header = request.headers.get('authorization');
		if (!header) return refuse(401, 'Authorization required');
		const separator = header.indexOf(' ');
		const scheme = header.slice(0, separator).toLowerCase();
		const value = header.slice(separator + 1).trim();
		if (scheme !== 'bearer')
			return refuse(401, 'Unsupported authorization scheme');
		if (value.startsWith(LOCAL_KEY_PREFIX)) return authenticateLocalKey(value);
		if (!idp) return refuse(401, 'Unknown API key', 'invalid_token');
		const verified = value.startsWith(OIDC_KEY_PREFIX)
			? await verifyKey(idp, value)
			: await verifyToken(idp, value);
		return verified instanceof Response
			? verified
			: signInVerified(idp, verified);
	};

	const resourceMetadata = (idp: Idp) => () =>
		Response.json({
			resource: new URL('/mcp', idp.publicUrl).href,
			authorization_servers: [idp.metadata.issuer],
			scopes_supported: idp.scopes,
			bearer_methods_supported: ['header'],
			resource_name: 'aawa-mcpx',
		});

	return {
		authenticate,
		// The Tester's request signs in as this user, with no credentials.
		signTesterRequest: (request: Request, userId: string) => {
			testerRequests.set(request, userId);
		},
		routes: (idp
			? Object.fromEntries(
					RESOURCE_METADATA_PATHS.map((path) => [
						path,
						{
							GET: resourceMetadata(idp),
						},
					]),
				)
			: {}) as Partial<
			Record<(typeof RESOURCE_METADATA_PATHS)[number], { GET: () => Response }>
		>,
	};
};

type McpAuth = ReturnType<typeof createMcpAuth>;

export type { McpAuth, McpPrincipal };
export { createMcpAuth };
