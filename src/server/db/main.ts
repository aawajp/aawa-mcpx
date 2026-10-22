import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '@/server/config/schema';
import { logger } from '@/server/logger';

import { Database } from 'bun:sqlite';

// Schema changes in order; the schema version (`PRAGMA user_version`) is the
// number of applied entries. Entries are never edited or removed, only
// appended.
const MIGRATIONS: readonly string[] = [];

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
