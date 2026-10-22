import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import { recordOf } from '@/shared/mcp_protocol';
import type { TrafficPage, TrafficRecord } from '@/shared/ui_api';

import { Database } from 'bun:sqlite';

// Only the newest records are kept, so a long run cannot fill the disk: at
// most `records`, of at most `bytes` of stored text in all. A request or
// response over `bodyBytes` is stored as its size and its start, and a
// client, method or protocol version over TEXT_LENGTH characters as its
// start; the message itself is unchanged. Backend names come from mcp.json
// and stay whole, as Debug looks traffic up by them.
const TRAFFIC_LIMITS = {
	records: 10_000,
	bytes: 512 * 1024 * 1024,
	bodyBytes: 256 * 1024,
};
type TrafficLimits = typeof TRAFFIC_LIMITS;
// Characters of a stored body's start; at most 4 bytes each.
const TRUNCATED_START_LENGTH = 16 * 1024;
const TEXT_LENGTH = 256;

type TrafficKind = TrafficRecord['kind'];
type TrafficEventType = TrafficRecord['eventType'];

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
	}) => TrafficPage;
	getBackendTraffic: (params: {
		backend: string;
		method?: string;
		limit: number;
		offset: number;
		errorsOnly?: boolean;
	}) => TrafficPage;
};

const storedBody = (value: unknown, limit: number): string => {
	const text = JSON.stringify(value ?? {});
	const bytes = Buffer.byteLength(text);
	return bytes > limit
		? JSON.stringify({
				truncated: true,
				bytes,
				start: text.slice(0, TRUNCATED_START_LENGTH),
			})
		: text;
};

// Clients choose methods and protocol versions, and name themselves.
const storedText = (value: string | undefined): string | null =>
	value === undefined
		? null
		: value.length > TEXT_LENGTH
			? `${value.slice(0, TEXT_LENGTH)}…`
			: value;

const safeParse = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const createTrafficStore = (
	dbPath: string,
	limits: TrafficLimits = TRAFFIC_LIMITS,
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
	db.run('PRAGMA journal_mode = WAL;');
	// Traffic is a debugging aid; WAL keeps it consistent without a sync per write.
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('DROP TABLE IF EXISTS traffic;');
	db.run(`
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
			bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
	`);
	db.run(
		'CREATE INDEX IF NOT EXISTS idx_traffic_kind_error_id ON traffic(kind, is_error, id DESC);',
	);
	db.run(
		'CREATE INDEX IF NOT EXISTS idx_traffic_backend_peer_error_id ON traffic(kind, peer, is_error, id DESC);',
	);
	db.run(
		'CREATE INDEX IF NOT EXISTS idx_traffic_backend_peer_method_error_id ON traffic(kind, peer, method, is_error, id DESC);',
	);
	const insertStmt = db.prepare(
		'INSERT INTO traffic (kind, peer, method, related_method, event_type, is_error, request, response, bytes, created_at, protocol_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	);
	const pruneStmt = db.prepare<{ bytes: number }, [number]>(
		'DELETE FROM traffic WHERE id <= ? RETURNING bytes',
	);
	const pruneOldestStmt = db.prepare<{ bytes: number }, []>(
		'DELETE FROM traffic WHERE id = (SELECT MIN(id) FROM traffic) RETURNING bytes',
	);
	// The table starts empty on each start.
	let storedBytes = 0;
	const forget = (rows: { bytes: number }[]) => {
		for (const row of rows) storedBytes -= row.bytes;
	};
	// A tool result with isError: true is logged as is (backend) or inside a
	// JSON-RPC response (client); both count as errors.
	const isErrorResponse = (value: unknown): boolean => {
		const record = recordOf(value);
		if (!record) return false;
		return (
			(record.error !== undefined && record.error !== null) ||
			record.isError === true ||
			recordOf(record.result)?.isError === true
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
			if (isErrorResponse(params.response)) {
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
		if (isErrorResponse(params.response)) {
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
		// Logging is for debugging; a failed write never changes the reply.
		try {
			const request = storedBody(params.request, limits.bodyBytes);
			const response = storedBody(params.response, limits.bodyBytes);
			const texts = {
				peer: kind === 'client' ? (storedText(peer) ?? '') : peer,
				method: storedText(params.method),
				relatedMethod: storedText(event.relatedMethod),
				protocolVersion: storedText(params.protocolVersion),
			};
			const bytes = [request, response, ...Object.values(texts)].reduce(
				(sum, text) => sum + Buffer.byteLength(text ?? ''),
				0,
			);
			const { lastInsertRowid } = insertStmt.run(
				kind,
				texts.peer,
				texts.method,
				texts.relatedMethod,
				event.eventType,
				event.isError,
				request,
				response,
				bytes,
				Date.now(),
				texts.protocolVersion,
			);
			storedBytes += bytes;
			forget(pruneStmt.all(Number(lastInsertRowid) - limits.records));
			while (storedBytes > limits.bytes) forget(pruneOldestStmt.all());
		} catch (error) {
			logger.error(`Traffic log write failed: ${errorMessage(error)}`);
		}
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
	}): TrafficPage => {
		const conditions = ['kind = ?'];
		const bindings: Array<string | number> = [params.kind];
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

	return {
		logClientTraffic,
		logBackendTraffic,
		getClientTraffic,
		getBackendTraffic,
	};
};

export type { LogBackendTrafficParams, LogClientTrafficParams, TrafficStore };
export { createTrafficStore, TRAFFIC_LIMITS };
