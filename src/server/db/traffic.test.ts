import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTrafficStore, TRAFFIC_LIMITS } from '@/server/db/traffic';
import { logger } from '@/server/logger';
import { trafficPageType } from '@/shared/ui_api';

import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';

test('traffic filters isolate peers and keep paginated totals consistent', () => {
	const store = createTrafficStore(':memory:');
	for (const backend of ['first', 'second']) {
		for (const method of ['tools/list', 'prompts/list']) {
			for (const failed of [false, true]) {
				const entry = {
					method,
					request: {},
					response: failed
						? {
								error: 'failed',
							}
						: {},
				};
				store.logBackendTraffic({
					...entry,
					backend,
				});
				store.logClientTraffic(entry);
			}
		}
	}
	for (const errorsOnly of [false, true]) {
		for (const method of [undefined, 'tools/list']) {
			const page = store.getBackendTraffic({
				backend: 'first',
				method,
				errorsOnly,
				limit: 1,
				offset: 1,
			});
			expect(page.total).toBe((method ? 1 : 2) * (errorsOnly ? 1 : 2));
			expect(page.records).toHaveLength(page.total > 1 ? 1 : 0);
			for (const record of page.records) {
				expect(record.peer).toBe('first');
				if (method) expect(record.method).toBe(method);
				if (errorsOnly) expect(record.isError).toBe(true);
			}
		}
		const clients = store.getClientTraffic({
			errorsOnly,
			limit: 1,
			offset: 1,
		});
		expect(clients.total).toBe(errorsOnly ? 4 : 8);
		expect(clients.records[0]?.kind).toBe('client');
	}
});

test('traffic snapshots retain client and backend protocol versions', () => {
	const store = createTrafficStore(':memory:');
	store.logClientTraffic({
		protocolVersion: '2026-07-28',
		method: 'tools/list',
		request: {},
		response: {},
	});
	store.logBackendTraffic({
		backend: 'fixture',
		protocolVersion: '2025-06-18',
		method: 'tools/list',
		request: {},
		response: {
			error: {
				code: -32603,
			},
		},
	});
	expect(
		trafficPageType.assert(
			store.getClientTraffic({
				limit: 10,
				offset: 0,
			}),
		).records[0]?.protocolVersion,
	).toBe('2026-07-28');
	for (const errorsOnly of [false, true])
		for (const method of [undefined, 'tools/list'])
			expect(
				trafficPageType.assert(
					store.getBackendTraffic({
						backend: 'fixture',
						limit: 10,
						offset: 0,
						method,
						errorsOnly,
					}),
				).records[0]?.protocolVersion,
			).toBe('2025-06-18');
});

test('tool results with isError: true are logged as errors', () => {
	const store = createTrafficStore(':memory:');
	const toolError = {
		content: [],
		isError: true,
	};
	store.logClientTraffic({
		method: 'tools/call',
		request: {},
		response: {
			jsonrpc: '2.0',
			id: 1,
			result: toolError,
		},
	});
	store.logBackendTraffic({
		backend: 'fixture',
		method: 'tools/call',
		request: {},
		response: toolError,
	});
	const page = {
		limit: 10,
		offset: 0,
		errorsOnly: true,
	};
	for (const { records } of [
		store.getClientTraffic(page),
		store.getBackendTraffic({
			...page,
			backend: 'fixture',
		}),
	])
		expect(records).toMatchObject([
			{
				eventType: 'error',
				isError: true,
			},
		]);
});

test('a failed traffic write is logged and does not throw', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mcpx-traffic-'));
	const error = spyOn(logger, 'error');
	try {
		const dbPath = path.join(root, 'traffic.db');
		const store = createTrafficStore(dbPath);
		const db = new Database(dbPath);
		db.run('DROP TABLE traffic;');
		db.close();
		expect(() =>
			store.logClientTraffic({
				method: 'tools/call',
				request: {},
				response: {},
			}),
		).not.toThrow();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Traffic log write failed'),
		);
	} finally {
		error.mockRestore();
		await rm(root, {
			recursive: true,
			force: true,
		});
	}
});

test('traffic keeps only the newest records', () => {
	const store = createTrafficStore(':memory:');
	for (let index = 0; index < TRAFFIC_LIMITS.records + 5; index++)
		store.logClientTraffic({
			method: `method-${index}`,
			request: {},
			response: {},
		});
	const page = store.getClientTraffic({
		limit: 1,
		offset: TRAFFIC_LIMITS.records - 1,
	});
	expect(page.total).toBe(TRAFFIC_LIMITS.records);
	expect(page.records[0]?.method).toBe('method-5');
});

test('traffic keeps at most its byte budget, and stores a long body as its size and start', () => {
	const store = createTrafficStore(':memory:', {
		records: 100,
		bytes: 1000,
		bodyBytes: 300,
	});
	// 202 bytes of request, 2 of response, 7 of peer ("unknown") and 16 of
	// method and related method per record.
	for (let index = 0; index < 6; index++)
		store.logClientTraffic({
			method: `method-${index}`,
			request: 'a'.repeat(200),
			response: {},
		});
	const kept = store.getClientTraffic({
		limit: 10,
		offset: 0,
	});
	expect(kept.records.map((record) => record.method)).toEqual([
		'method-5',
		'method-4',
		'method-3',
		'method-2',
	]);
	// 302 bytes as JSON, 'ä' being 2 bytes.
	store.logClientTraffic({
		method: 'long',
		request: {},
		response: 'ä'.repeat(150),
	});
	const [long] = store.getClientTraffic({
		limit: 1,
		offset: 0,
	}).records;
	expect(long?.request).toEqual({});
	expect(long?.response).toEqual({
		truncated: true,
		bytes: 302,
		start: JSON.stringify('ä'.repeat(150)),
	});
});

test('long peers, methods and protocol versions are stored as their start, and count', () => {
	const store = createTrafficStore(':memory:', {
		records: 100,
		bytes: 3200,
		bodyBytes: 300,
	});
	for (const char of ['m', 'ä'])
		store.logClientTraffic({
			client: char.repeat(1000),
			method: char.repeat(1000),
			protocolVersion: char.repeat(1000),
			request: {},
			response: {},
		});
	const [multibyte, ascii] = store.getClientTraffic({
		limit: 10,
		offset: 0,
	}).records;
	for (const [record, char] of [
		[ascii, 'm'],
		[multibyte, 'ä'],
	] as const) {
		const start = `${char.repeat(256)}…`;
		expect(record).toMatchObject({
			peer: start,
			method: start,
			relatedMethod: start,
			protocolVersion: start,
		});
	}
	// 4 × 259 bytes for "m" and 4 × 515 for "ä", plus 4 of bodies each, fit;
	// 3 × 259 + 4 more do not, so the oldest goes.
	store.logClientTraffic({
		client: 'm'.repeat(1000),
		method: 'm'.repeat(1000),
		request: {},
		response: {},
	});
	expect(
		store
			.getClientTraffic({
				limit: 10,
				offset: 0,
			})
			.records.map((record) => record.protocolVersion?.[0]),
	).toEqual([undefined, 'ä']);
});

test('backend names stay whole, so long ones sharing a start stay apart', () => {
	const store = createTrafficStore(':memory:');
	const names = ['a', 'b'].map((last) => `${'x'.repeat(300)}${last}`);
	for (const backend of names)
		store.logBackendTraffic({
			backend,
			method: 'tools/list',
			request: {},
			response: {},
		});
	for (const backend of names)
		expect(
			store
				.getBackendTraffic({
					backend,
					limit: 10,
					offset: 0,
				})
				.records.map((record) => record.peer),
		).toEqual([backend]);
});
