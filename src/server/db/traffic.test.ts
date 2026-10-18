import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTrafficStore, MAX_TRAFFIC_RECORDS } from '@/server/db/traffic';
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
	for (let index = 0; index < MAX_TRAFFIC_RECORDS + 5; index++)
		store.logClientTraffic({
			method: `method-${index}`,
			request: {},
			response: {},
		});
	const page = store.getClientTraffic({
		limit: 1,
		offset: MAX_TRAFFIC_RECORDS - 1,
	});
	expect(page.total).toBe(MAX_TRAFFIC_RECORDS);
	expect(page.records[0]?.method).toBe('method-5');
});
