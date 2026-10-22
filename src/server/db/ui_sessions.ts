import { type } from 'arktype';

import type { Database } from 'bun:sqlite';

// A dashboard login. Only a hash of the session ID is stored; the ID itself
// lives in the browser's cookie.
type UiSession = {
	idHash: string;
	issuer: string;
	clientId: string;
	// Every ID token claim, kept whole for debugging.
	claims: Record<string, unknown>;
	createdAt: number;
	lastUsedAt: number;
};

// The login's OAuth tokens: the Tester sends the access token to /mcp as the
// logged-in admin. They are stored encrypted with a key derived from the
// session ID, so the database alone cannot read them.
const loginTokensType = type({
	accessToken: 'string',
	'refreshToken?': 'string',
	expiresAt: 'number',
});
type LoginTokens = typeof loginTokensType.infer;

type UiSessionRow = {
	id_hash: string;
	issuer: string;
	client_id: string;
	claims: string;
	created_at: number;
	last_used_at: number;
};

type UiSessionStore = {
	create: (session: Omit<UiSession, 'idHash' | 'lastUsedAt'>) => {
		sessionId: string;
		session: UiSession;
	};
	find: (sessionId: string) => UiSession | undefined;
	list: () => UiSession[];
	touch: (idHash: string, lastUsedAt: number) => void;
	delete: (idHash: string) => void;
	// Deletes the user's sessions and returns how many there were.
	deleteForUser: (userId: string) => number;
	saveTokens: (sessionId: string, tokens: LoginTokens) => Promise<void>;
	findTokens: (sessionId: string) => Promise<LoginTokens | undefined>;
};

const SESSION_ID_BYTES = 32;
const IV_BYTES = 12;
const TOKEN_KEY_INFO = new TextEncoder().encode('aawa-mcpx login tokens');

const hashSessionId = (sessionId: string): string =>
	new Bun.CryptoHasher('sha256').update(sessionId).digest('hex');

// The session ID is 32 random bytes, so HKDF needs no salt.
const tokenKey = async (sessionId: string): Promise<CryptoKey> =>
	crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(),
			info: TOKEN_KEY_INFO,
		},
		await crypto.subtle.importKey(
			'raw',
			Buffer.from(sessionId, 'base64url'),
			'HKDF',
			false,
			['deriveKey'],
		),
		{
			name: 'AES-GCM',
			length: 256,
		},
		false,
		['encrypt', 'decrypt'],
	);

// Stored as base64url IV and ciphertext, joined by a dot.
const encryptTokens = async (
	sessionId: string,
	tokens: LoginTokens,
): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		await tokenKey(sessionId),
		new TextEncoder().encode(JSON.stringify(tokens)),
	);
	return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
};

const decryptTokens = async (
	sessionId: string,
	value: string,
): Promise<LoginTokens> => {
	const [iv = '', ciphertext = ''] = value.split('.');
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: Buffer.from(iv, 'base64url'),
		},
		await tokenKey(sessionId),
		Buffer.from(ciphertext, 'base64url'),
	);
	return loginTokensType.assert(
		JSON.parse(new TextDecoder().decode(plaintext)),
	);
};

const fromRow = (row: UiSessionRow): UiSession => ({
	idHash: row.id_hash,
	issuer: row.issuer,
	clientId: row.client_id,
	claims: JSON.parse(row.claims),
	createdAt: row.created_at,
	lastUsedAt: row.last_used_at,
});

const createUiSessionStore = (db: Database): UiSessionStore => {
	const insertStmt = db.prepare(
		'INSERT INTO ui_sessions (id_hash, issuer, client_id, claims, created_at, last_used_at) VALUES ($idHash, $issuer, $clientId, $claims, $createdAt, $createdAt)',
	);
	const findStmt = db.prepare<UiSessionRow, { idHash: string }>(
		'SELECT * FROM ui_sessions WHERE id_hash = $idHash',
	);
	const listStmt = db.prepare<UiSessionRow, []>('SELECT * FROM ui_sessions');
	const touchStmt = db.prepare(
		'UPDATE ui_sessions SET last_used_at = $lastUsedAt WHERE id_hash = $idHash',
	);
	const deleteStmt = db.prepare(
		'DELETE FROM ui_sessions WHERE id_hash = $idHash',
	);
	const deleteForUserStmt = db.prepare(
		"DELETE FROM ui_sessions WHERE json_extract(claims, '$.sub') = $userId",
	);
	const saveTokensStmt = db.prepare(
		'UPDATE ui_sessions SET tokens = $tokens WHERE id_hash = $idHash',
	);
	const findTokensStmt = db.prepare<
		{ tokens: string | null },
		{ idHash: string }
	>('SELECT tokens FROM ui_sessions WHERE id_hash = $idHash');
	return {
		create: ({ issuer, clientId, claims, createdAt }) => {
			const sessionId = Buffer.from(
				crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)),
			).toString('base64url');
			const idHash = hashSessionId(sessionId);
			insertStmt.run({
				idHash,
				issuer,
				clientId,
				claims: JSON.stringify(claims),
				createdAt,
			});
			return {
				sessionId,
				session: {
					idHash,
					issuer,
					clientId,
					claims,
					createdAt,
					lastUsedAt: createdAt,
				},
			};
		},
		find: (sessionId) => {
			const row = findStmt.get({
				idHash: hashSessionId(sessionId),
			});
			return row ? fromRow(row) : undefined;
		},
		list: () => listStmt.all().map(fromRow),
		touch: (idHash, lastUsedAt) => {
			touchStmt.run({
				idHash,
				lastUsedAt,
			});
		},
		delete: (idHash) => {
			deleteStmt.run({
				idHash,
			});
		},
		deleteForUser: (userId) =>
			deleteForUserStmt.run({
				userId,
			}).changes,
		saveTokens: async (sessionId, tokens) => {
			saveTokensStmt.run({
				idHash: hashSessionId(sessionId),
				tokens: await encryptTokens(sessionId, tokens),
			});
		},
		findTokens: async (sessionId) => {
			const value = findTokensStmt.get({
				idHash: hashSessionId(sessionId),
			})?.tokens;
			return value ? decryptTokens(sessionId, value) : undefined;
		},
	};
};

export type { LoginTokens, UiSession, UiSessionStore };
export { createUiSessionStore };
