import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigurationError } from '@/server/config/schema';
import { openMainDatabase } from '@/server/db/main';

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';

const FIRST =
	'CREATE TABLE first (id INTEGER PRIMARY KEY); INSERT INTO first VALUES (1);';
const SECOND = 'CREATE TABLE second (id INTEGER PRIMARY KEY);';

let dir: string;
let dbPath: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'aawa-mcpx-main-db-'));
	dbPath = path.join(dir, 'db', 'main.db');
});

afterEach(async () => {
	await rm(dir, {
		recursive: true,
		force: true,
	});
});

const version = (db: Database): number | undefined =>
	db.query<{ user_version: number }, []>('PRAGMA user_version').get()
		?.user_version;

const tables = (db: Database): string[] =>
	db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		)
		.all()
		.map((row) => row.name);

test('a new database gets its directory and every migration', () => {
	const db = openMainDatabase(dbPath, [FIRST, SECOND]);
	expect(version(db)).toBe(2);
	expect(tables(db)).toEqual(['first', 'second']);
	db.close();
});

test('reopening applies only migrations added since and keeps data', () => {
	openMainDatabase(dbPath, [FIRST]).close();
	const db = openMainDatabase(dbPath, [FIRST, SECOND]);
	expect(version(db)).toBe(2);
	expect(db.query('SELECT id FROM first').all()).toEqual([
		{
			id: 1,
		},
	]);
	db.close();
});

test('a failing migration keeps the last good version', () => {
	expect(() =>
		openMainDatabase(dbPath, [FIRST, 'CREATE TABLE second (id); INVALID SQL']),
	).toThrow();
	const db = openMainDatabase(dbPath, [FIRST]);
	expect(version(db)).toBe(1);
	expect(tables(db)).toEqual(['first']);
	db.close();
});

test('a schema newer than the code stops startup', () => {
	openMainDatabase(dbPath, [FIRST, SECOND]).close();
	expect(() => openMainDatabase(dbPath, [FIRST])).toThrow(
		new ConfigurationError(
			'Main database schema version 2 is newer than this gateway supports (1)',
		),
	);
});
