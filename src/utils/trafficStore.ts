import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';

type TrafficKind = 'client' | 'backend';

type TrafficRecord = {
	id: number;
	kind: TrafficKind;
	peer: string;
	method?: string;
	request: unknown;
	response: unknown;
	createdAt: number;
};

type TrafficQueryResult = {
	records: TrafficRecord[];
	total: number;
};

type LogClientTrafficParams = {
	sessionId?: string;
	method?: string;
	request: unknown;
	response: unknown;
};

type LogBackendTrafficParams = {
	backend: string;
	method?: string;
	request: unknown;
	response: unknown;
};

type TrafficStore = {
	logClientTraffic: (params: LogClientTrafficParams) => void;
	logBackendTraffic: (params: LogBackendTrafficParams) => void;
	getClientTraffic: (params: {
		limit: number;
		offset: number;
	}) => TrafficQueryResult;
	getBackendTraffic: (params: {
		backend: string;
		method?: string;
		limit: number;
		offset: number;
	}) => TrafficQueryResult;
	upsertBackendInfo: (params: {
		backend: string;
		url: string;
		capabilities?: unknown;
		implementation?: unknown;
		instructions?: string;
	}) => void;
	upsertTools: (params: { backend: string; tools: unknown[] }) => void;
	upsertPrompts: (params: { backend: string; prompts: unknown[] }) => void;
	upsertResources: (params: { backend: string; resources: unknown[] }) => void;
};

const DATABASE_FILENAME = path.join('db', 'traffic.db');

const safeParse = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const createTrafficStore = (): TrafficStore => {
	const dbPath = path.join(process.cwd(), DATABASE_FILENAME);
	const dbDir = path.dirname(dbPath);
	if (!existsSync(dbDir)) {
		try {
			mkdirSync(dbDir, { recursive: true });
		} catch {
			// ignore best-effort directory creation
		}
	}
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS traffic (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			peer TEXT NOT NULL,
			method TEXT,
			request TEXT,
			response TEXT,
			created_at INTEGER NOT NULL
		);
	`);
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_traffic_kind_created_at ON traffic(kind, created_at DESC);',
	);
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_traffic_peer_created_at ON traffic(peer, created_at DESC);',
	);
	db.exec(`
		CREATE TABLE IF NOT EXISTS backends (
			name TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			capabilities TEXT,
			implementation TEXT,
			instructions TEXT,
			updated_at INTEGER NOT NULL
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS tools (
			backend TEXT NOT NULL,
			name TEXT NOT NULL,
			data TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (backend, name)
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS prompts (
			backend TEXT NOT NULL,
			name TEXT NOT NULL,
			data TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (backend, name)
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS resources (
			backend TEXT NOT NULL,
			uri TEXT NOT NULL,
			data TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (backend, uri)
		);
	`);

	const insertStmt = db.prepare(
		'INSERT INTO traffic (kind, peer, method, request, response, created_at) VALUES (?, ?, ?, ?, ?, ?)',
	);
	const upsertBackendStmt = db.prepare(
		`
			INSERT INTO backends (name, url, capabilities, implementation, instructions, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(name) DO UPDATE SET
				url=excluded.url,
				capabilities=excluded.capabilities,
				implementation=excluded.implementation,
				instructions=excluded.instructions,
				updated_at=excluded.updated_at
		`,
	);
	const upsertToolStmt = db.prepare(
		`
			INSERT INTO tools (backend, name, data, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(backend, name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
		`,
	);
	const upsertPromptStmt = db.prepare(
		`
			INSERT INTO prompts (backend, name, data, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(backend, name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
		`,
	);
	const upsertResourceStmt = db.prepare(
		`
			INSERT INTO resources (backend, uri, data, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(backend, uri) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
		`,
	);

	const logClientTraffic = (params: LogClientTrafficParams) => {
		const { sessionId, method, request, response } = params;
		insertStmt.run(
			'client',
			sessionId ?? 'unknown',
			method ?? null,
			JSON.stringify(request ?? {}),
			JSON.stringify(response ?? {}),
			Date.now(),
		);
	};

	const logBackendTraffic = (params: LogBackendTrafficParams) => {
		const { backend, method, request, response } = params;
		insertStmt.run(
			'backend',
			backend,
			method ?? null,
			JSON.stringify(request ?? {}),
			JSON.stringify(response ?? {}),
			Date.now(),
		);
	};

	const mapRows = (rows: Array<Record<string, unknown>>): TrafficRecord[] =>
		rows.map((row) => ({
			id: Number(row.id),
			kind: row.kind as TrafficKind,
			peer: String(row.peer),
			method: row.method ? String(row.method) : undefined,
			request: row.request ? safeParse(String(row.request)) : {},
			response: row.response ? safeParse(String(row.response)) : {},
			createdAt: Number(row.created_at),
		}));

	const getClientTraffic = (params: { limit: number; offset: number }) => {
		const { limit, offset } = params;
		const rows = db
			.prepare(
				'\
					SELECT id, kind, peer, method, request, response, created_at\
					FROM traffic WHERE kind = ?\
					ORDER BY id DESC\
					LIMIT ? OFFSET ?\
				',
			)
			.all('client', limit, offset) as Array<Record<string, unknown>>;

		const totalRow = db
			.prepare('SELECT COUNT(*) as count FROM traffic WHERE kind = ?')
			.get('client') as { count: number };

		return { records: mapRows(rows), total: Number(totalRow.count) };
	};

	const getBackendTraffic = (params: {
		backend: string;
		method?: string;
		limit: number;
		offset: number;
	}) => {
		const { backend, method, limit, offset } = params;
		const rows = method
			? (db
					.prepare(
						'\
						SELECT id, kind, peer, method, request, response, created_at\
						FROM traffic WHERE kind = ? AND peer = ? AND method = ?\
						ORDER BY id DESC\
						LIMIT ? OFFSET ?\
					',
					)
					.all('backend', backend, method, limit, offset) as Array<
					Record<string, unknown>
				>)
			: (db
					.prepare(
						'\
						SELECT id, kind, peer, method, request, response, created_at\
						FROM traffic WHERE kind = ? AND peer = ?\
						ORDER BY id DESC\
						LIMIT ? OFFSET ?\
					',
					)
					.all('backend', backend, limit, offset) as Array<
					Record<string, unknown>
				>);

		const totalRow = method
			? (db
					.prepare(
						'SELECT COUNT(*) as count FROM traffic WHERE kind = ? AND peer = ? AND method = ?',
					)
					.get('backend', backend, method) as { count: number })
			: (db
					.prepare(
						'SELECT COUNT(*) as count FROM traffic WHERE kind = ? AND peer = ?',
					)
					.get('backend', backend) as { count: number });

		return { records: mapRows(rows), total: Number(totalRow.count) };
	};

	const upsertBackendInfo = (params: {
		backend: string;
		url: string;
		capabilities?: unknown;
		implementation?: unknown;
		instructions?: string;
	}) => {
		const { backend, url, capabilities, implementation, instructions } = params;
		upsertBackendStmt.run(
			backend,
			url,
			capabilities ? JSON.stringify(capabilities) : null,
			implementation ? JSON.stringify(implementation) : null,
			instructions ?? null,
			Date.now(),
		);
	};

	const upsertTools = (params: { backend: string; tools: unknown[] }) => {
		const now = Date.now();
		for (const tool of params.tools) {
			const name = (tool as { name?: string }).name;
			if (!name) continue;
			upsertToolStmt.run(params.backend, name, JSON.stringify(tool), now);
		}
	};

	const upsertPrompts = (params: { backend: string; prompts: unknown[] }) => {
		const now = Date.now();
		for (const prompt of params.prompts) {
			const name = (prompt as { name?: string }).name;
			if (!name) continue;
			upsertPromptStmt.run(params.backend, name, JSON.stringify(prompt), now);
		}
	};

	const upsertResources = (params: {
		backend: string;
		resources: unknown[];
	}) => {
		const now = Date.now();
		for (const resource of params.resources) {
			const uri = (resource as { uri?: string }).uri;
			if (!uri) continue;
			upsertResourceStmt.run(
				params.backend,
				uri,
				JSON.stringify(resource),
				now,
			);
		}
	};

	return {
		logClientTraffic,
		logBackendTraffic,
		getClientTraffic,
		getBackendTraffic,
		upsertBackendInfo,
		upsertTools,
		upsertPrompts,
		upsertResources,
	};
};

export type {
	TrafficStore,
	TrafficRecord,
	TrafficQueryResult,
	LogClientTrafficParams,
	LogBackendTrafficParams,
};

export { createTrafficStore };
