import { createTrafficStore } from '@/server/traffic_store';
import { trafficPageType } from '@/shared/ui_api';

import { expect, test } from 'bun:test';

test('traffic filters isolate peers and keep paginated totals consistent', () => {
	const store = createTrafficStore(':memory:');
	for (const backend of [
		'first',
		'second',
	]) {
		for (const method of [
			'tools/list',
			'prompts/list',
		]) {
			for (const failed of [
				false,
				true,
			]) {
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
	for (const errorsOnly of [
		false,
		true,
	]) {
		for (const method of [
			undefined,
			'tools/list',
		]) {
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
	for (const errorsOnly of [
		false,
		true,
	])
		for (const method of [
			undefined,
			'tools/list',
		])
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
