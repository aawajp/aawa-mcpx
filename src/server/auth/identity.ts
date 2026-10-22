import * as client from 'openid-client';

import { type LogField, logFields, logger } from '@/server/logger';

// A user's names, roles and last-seen time, a key's last use and a dashboard
// session's last use are written at most this often, not on every request;
// changed roles are written at once.
const TOUCH_INTERVAL_MS = 60_000;

const isDue = (lastAt: number | undefined, now: number) =>
	now - (lastAt ?? 0) >= TOUCH_INTERVAL_MS;

// Plain HTTP is allowed only for a loopback issuer, which the settings
// already enforce.
const isPlainHttp = (issuer: string | URL) =>
	new URL(issuer).protocol === 'http:';

const discoverIssuer = (
	issuer: URL,
	clientId: string,
	clientSecret: string,
): Promise<client.Configuration> =>
	client.discovery(
		issuer,
		clientId,
		undefined,
		client.ClientSecretBasic(clientSecret),
		isPlainHttp(issuer)
			? {
					execute: [client.allowInsecureRequests],
				}
			: undefined,
	);

// Another client of a discovered issuer, such as a machine's.
const issuerClient = (
	metadata: client.ServerMetadata,
	clientId: string,
	clientSecret: string,
): client.Configuration => {
	const config = new client.Configuration(
		metadata,
		clientId,
		undefined,
		client.ClientSecretBasic(clientSecret),
	);
	if (isPlainHttp(metadata.issuer)) client.allowInsecureRequests(config);
	return config;
};

// The roles claim is either a list of role names or an object keyed by role,
// as IdPs differ.
const rolesOf = (claims: Record<string, unknown>, rolesClaim: string) => {
	const value = claims[rolesClaim];
	if (Array.isArray(value))
		return value.filter((role) => typeof role === 'string');
	return value !== null && typeof value === 'object' ? Object.keys(value) : [];
};

// A user's labels from the standard profile claims.
const profileOf = (
	claims: Record<string, unknown>,
): { name?: string; username?: string } => {
	const text = (value: unknown) =>
		typeof value === 'string' && value !== '' ? value : undefined;
	return {
		name: text(claims.name),
		username: text(claims.preferred_username),
	};
};

type SignInFlow =
	| 'oidc_login'
	| 'password_login'
	| 'oauth_access_token'
	| 'oidc_api_key'
	| 'local_api_key'
	// The dashboard Tester, as the logged-in superadmin.
	| 'tester';

type SignIn = {
	flow: SignInFlow;
	userId: string;
	// The IdP app the token was issued to.
	appClientId?: string;
	// The service account an API key names.
	serviceAccountClientId?: string;
	keyId?: string;
	clientIp?: string;
	roles: readonly string[];
	rolesClaim?: string;
	scope?: string;
	claimNames: Iterable<string>;
};

// One line per sign-in, the same snake_case fields for every flow. Claim
// names, not values, show where roles are missing; no secrets, keys or tokens.
const logSignIn = (signIn: SignIn) =>
	logger.info(
		`Auth: ${logFields({
			flow: signIn.flow,
			user_id: signIn.userId,
			app_client_id: signIn.appClientId,
			service_account_client_id: signIn.serviceAccountClientId,
			key_id: signIn.keyId,
			client_ip: signIn.clientIp,
			roles: signIn.roles,
			roles_claim: signIn.rolesClaim,
			scopes_granted: signIn.scope?.split(' '),
			claims: [...signIn.claimNames],
		})}`,
	);

// One line per refused sign-in: its flow, what is known of it, and why.
const logRefusal = (
	refusal: { flow: SignInFlow; reason: string } & Record<string, LogField>,
) => logger.warn(`Auth refused: ${logFields(refusal)}`);

export type { SignIn, SignInFlow };
export {
	discoverIssuer,
	isDue,
	issuerClient,
	logRefusal,
	logSignIn,
	profileOf,
	rolesOf,
};
