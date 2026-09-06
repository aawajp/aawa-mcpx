import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';

type TrafficKind = 'client' | 'backend';
type TrafficEventType = 'success' | 'error' | 'validation_error';

type TrafficRecord = {
	protocolVersion?: string;
	id: number;
	kind: TrafficKind;
	peer: string;
	method?: string;
	relatedMethod?: string;
	eventType: TrafficEventType;
	request: unknown;
	response: unknown;
	isError: boolean;
	createdAt: number;
};

type TrafficQueryResult = {
	records: TrafficRecord[];
	total: number;
};

type LogClientTrafficParams = {
	protocolVersion?: string;
	client?: string;
	method?: string;
	request: unknown;
	response: unknown;
};

type LogBackendTrafficParams = {
	protocolVersion?: string;
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
		errorsOnly?: boolean;
	}) => TrafficQueryResult;
	getBackendTraffic: (params: {
		backend: string;
		method?: string;
		limit: number;
		offset: number;
		errorsOnly?: boolean;
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

const createTrafficStore = (
	dbPath = path.join(process.cwd(), DATABASE_FILENAME),
): TrafficStore => {
	const dbDir = path.dirname(dbPath);
	if (!existsSync(dbDir)) {
		try {
			mkdirSync(dbDir, {
				recursive: true,
			});
		} catch {
			// ignore best-effort directory creation
		}
	}
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('DROP TABLE IF EXISTS traffic;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS traffic (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			peer TEXT NOT NULL,
			method TEXT,
			protocol_version TEXT,
			related_method TEXT,
			event_type TEXT NOT NULL,
			is_error INTEGER NOT NULL,
			request TEXT,
			response TEXT,
			created_at INTEGER NOT NULL
		);
	`);
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_traffic_kind_error_id ON traffic(kind, is_error, id DESC);',
	);
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_traffic_backend_peer_error_id ON traffic(kind, peer, is_error, id DESC);',
	);
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_traffic_backend_peer_method_error_id ON traffic(kind, peer, method, is_error, id DESC);',
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
		'INSERT INTO traffic (kind, peer, method, related_method, event_type, is_error, request, response, created_at, protocol_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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

	const hasErrorObject = (value: unknown): boolean => {
		if (typeof value !== 'object' || value === null) return false;
		return (
			'error' in value && value.error !== undefined && value.error !== null
		);
	};

	const classifyEvent = (params: {
		method?: string;
		response: unknown;
	}): {
		relatedMethod?: string;
		eventType: TrafficEventType;
		isError: number;
	} => {
		const method = params.method;
		if (!method) {
			if (hasErrorObject(params.response)) {
				return {
					relatedMethod: undefined,
					eventType: 'error',
					isError: 1,
				};
			}
			return {
				relatedMethod: undefined,
				eventType: 'success',
				isError: 0,
			};
		}
		if (method.endsWith(':validation_error')) {
			return {
				relatedMethod: method.slice(0, -':validation_error'.length),
				eventType: 'validation_error',
				isError: 1,
			};
		}
		if (hasErrorObject(params.response)) {
			return {
				relatedMethod: method,
				eventType: 'error',
				isError: 1,
			};
		}
		return {
			relatedMethod: method,
			eventType: 'success',
			isError: 0,
		};
	};

	const logTraffic = (
		kind: TrafficKind,
		peer: string,
		params: LogClientTrafficParams | LogBackendTrafficParams,
	): void => {
		const event = classifyEvent(params);
		insertStmt.run(
			kind,
			peer,
			params.method ?? null,
			event.relatedMethod ?? null,
			event.eventType,
			event.isError,
			JSON.stringify(params.request ?? {}),
			JSON.stringify(params.response ?? {}),
			Date.now(),
			params.protocolVersion ?? null,
		);
	};
	const logClientTraffic = (params: LogClientTrafficParams): void =>
		logTraffic('client', params.client ?? 'unknown', params);
	const logBackendTraffic = (params: LogBackendTrafficParams): void =>
		logTraffic('backend', params.backend, params);

	const mapRows = (rows: Array<Record<string, unknown>>): TrafficRecord[] =>
		rows.map((row) => ({
			protocolVersion:
				typeof row.protocol_version === 'string'
					? row.protocol_version
					: undefined,
			id: Number(row.id),
			kind: row.kind as TrafficKind,
			peer: String(row.peer),
			method: row.method ? String(row.method) : undefined,
			relatedMethod: row.related_method
				? String(row.related_method)
				: undefined,
			eventType: String(row.event_type) as TrafficEventType,
			request: row.request ? safeParse(String(row.request)) : {},
			response: row.response ? safeParse(String(row.response)) : {},
			isError: Number(row.is_error) === 1,
			createdAt: Number(row.created_at),
		}));

	const getTraffic = (params: {
		kind: TrafficKind;
		backend?: string;
		method?: string;
		limit: number;
		offset: number;
		errorsOnly?: boolean;
	}): TrafficQueryResult => {
		const conditions = [
			'kind = ?',
		];
		const bindings: Array<string | number> = [
			params.kind,
		];
		if (params.backend !== undefined) {
			conditions.push('peer = ?');
			bindings.push(params.backend);
		}
		if (params.method) {
			conditions.push('method = ?');
			bindings.push(params.method);
		}
		if (params.errorsOnly) conditions.push('is_error = 1');
		// Build one filter for both queries so pagination totals cannot drift.
		// Only fixed SQL fragments are interpolated; filter values remain bound.
		const where = conditions.join(' AND ');
		const rows = db
			.prepare(`
			SELECT protocol_version, id, kind, peer, method, related_method,
				event_type, is_error, request, response, created_at
			FROM traffic WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?
		`)
			.all(...bindings, params.limit, params.offset) as Array<
			Record<string, unknown>
		>;
		const totalRow = db
			.prepare(`SELECT COUNT(*) as count FROM traffic WHERE ${where}`)
			.get(...bindings) as {
			count: number;
		};
		return {
			records: mapRows(rows),
			total: Number(totalRow.count),
		};
	};
	const getClientTraffic: TrafficStore['getClientTraffic'] = (params) =>
		getTraffic({
			...params,
			kind: 'client',
		});
	const getBackendTraffic: TrafficStore['getBackendTraffic'] = (params) =>
		getTraffic({
			...params,
			kind: 'backend',
		});

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
			const name = (
				tool as {
					name?: string;
				}
			).name;
			if (!name) continue;
			upsertToolStmt.run(params.backend, name, JSON.stringify(tool), now);
		}
	};

	const upsertPrompts = (params: { backend: string; prompts: unknown[] }) => {
		const now = Date.now();
		for (const prompt of params.prompts) {
			const name = (
				prompt as {
					name?: string;
				}
			).name;
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
			const uri = (
				resource as {
					uri?: string;
				}
			).uri;
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
	LogBackendTrafficParams,
	LogClientTrafficParams,
	TrafficQueryResult,
	TrafficRecord,
	TrafficStore,
};
export { createTrafficStore };
