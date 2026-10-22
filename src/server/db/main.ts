import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '@/server/config/schema';
import { logger } from '@/server/logger';

import { Database } from 'bun:sqlite';

// Schema changes in order; the schema version (`PRAGMA user_version`) is the
// number of applied entries. Entries are never edited or removed, only
// appended.
const MIGRATIONS: readonly string[] = [
	// 1: dashboard login sessions, see db/ui_sessions.ts.
	`CREATE TABLE ui_sessions (
		id_hash TEXT PRIMARY KEY,
		issuer TEXT NOT NULL,
		client_id TEXT NOT NULL,
		claims TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	) STRICT;`,
	// 2: MCP client users, roles, permissions and API keys, see db/access.ts,
	// and the encrypted login tokens of dashboard sessions. Users belong to a
	// realm and are humans or machines; one Local human is the superadmin.
	`ALTER TABLE ui_sessions ADD COLUMN tokens TEXT;
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		realm TEXT NOT NULL CHECK (realm IN ('oidc', 'local')),
		type TEXT NOT NULL CHECK (type IN ('human', 'machine')),
		superadmin INTEGER NOT NULL,
		name TEXT,
		username TEXT,
		enabled INTEGER NOT NULL,
		idp_roles TEXT NOT NULL DEFAULT '[]',
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER
	) STRICT;
	CREATE UNIQUE INDEX users_superadmin ON users (superadmin) WHERE superadmin = 1;
	CREATE TABLE roles (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE user_roles (
		user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
		PRIMARY KEY (user_id, role_id)
	) STRICT;
	CREATE TABLE permissions (
		holder_type TEXT NOT NULL CHECK (holder_type IN ('user', 'role')),
		holder_id TEXT NOT NULL,
		backend TEXT NOT NULL,
		tool TEXT NOT NULL,
		PRIMARY KEY (holder_type, holder_id, backend, tool)
	) STRICT;
	CREATE TABLE api_keys (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		hash TEXT NOT NULL UNIQUE,
		hint TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	) STRICT;`,
];

// Open the gateway's own database, kept across restarts, and bring its schema
// up to date. Each migration runs in its own transaction, so a failure leaves
// the last good version. A version newer than the code knows stops startup.
const openMainDatabase = (
	dbPath: string,
	migrations: readonly string[] = MIGRATIONS,
): Database => {
	mkdirSync(path.dirname(dbPath), {
		recursive: true,
	});
	const db = new Database(dbPath, {
		strict: true,
	});
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA foreign_keys = ON;');
	const current =
		db.query<{ user_version: number }, []>('PRAGMA user_version').get()
			?.user_version ?? 0;
	if (current > migrations.length) {
		db.close();
		throw new ConfigurationError(
			`Main database schema version ${current} is newer than this gateway supports (${migrations.length})`,
		);
	}
	for (const [index, migration] of migrations.entries()) {
		if (index < current) continue;
		db.transaction(() => {
			db.run(migration);
			db.run(`PRAGMA user_version = ${index + 1};`);
		})();
	}
	if (current < migrations.length)
		logger.info(
			`Main database schema updated from version ${current} to ${migrations.length}`,
		);
	return db;
};

export { openMainDatabase };
