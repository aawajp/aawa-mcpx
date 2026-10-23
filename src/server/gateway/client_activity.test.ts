import { createClientActivityTracker } from '@/server/gateway/client_activity';
import { createMcpSessionManager } from '@/server/gateway/mcp_session';
import { logger } from '@/server/logger';
import { parseClientInfo } from '@/shared/client_info';
import { overviewResponseType } from '@/shared/ui_api';

it('client info requires name and version when present; omitted identity uses unknown', () => {
	for (const value of [
		{},
		{
			name: 'test',
		},
		{
			version: '1',
		},
		{
			name: 'test',
			version: 1,
		},
	])
		expect(parseClientInfo(value)).toBeUndefined();
	expect(
		parseClientInfo({
			name: 'test',
			version: '1',
		}),
	).toEqual({
		name: 'test',
		version: '1',
	});
	const activity = createClientActivityTracker(10);
	activity.observe(undefined, '2026-07-28');
	activity.observe(undefined, '2026-07-28');
	expect(activity.list()).toHaveLength(1);
	expect(activity.list()[0]?.client).toEqual({
		name: 'unknown',
		version: 'unknown',
	});
});

import { expect, it, spyOn } from 'bun:test';

it('initialization retains the newest sessions per name/version without idle expiration', async () => {
	for (const maxSessionsPerClient of [10, 2]) {
		const sessions = createMcpSessionManager({
			maxSessionsPerClient,
			maxSessionsPerUser: 100,
		});
		const initialize = async (
			name = 'agent',
			version = '1',
			protocolVersion = '2025-11-25',
		) =>
			sessions.handleInitialize(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						clientInfo: {
							name,
							version,
						},
						protocolVersion,
					},
				},
				undefined,
			);
		const otherName = await initialize('other');
		const otherVersion = await initialize('agent', '2');
		const retained: Array<string | undefined> = [];
		for (let index = 0; index < maxSessionsPerClient; index++)
			retained.push(
				(
					await initialize(
						'agent',
						'1',
						index % 2 ? '2025-06-18' : '2025-11-25',
					)
				).sessionId,
			);
		for (const id of retained)
			expect(sessions.requireSession(id, 2)).toBeNull();
		await sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {},
			},
			undefined,
		);
		expect(sessions.requireSession(retained[0], 2)).toBeNull();
		const newest = await initialize();
		expect(sessions.requireSession(retained[0], 2)?.status).toBe(404);
		for (const id of [
			...retained.slice(1),
			newest.sessionId,
			otherName.sessionId,
			otherVersion.sessionId,
		])
			expect(sessions.requireSession(id, 2)).toBeNull();
		expect(sessions.activeCount()).toBe(maxSessionsPerClient + 2);
		expect(sessions.close(newest.sessionId).status).toBe(202);
		expect(sessions.requireSession(newest.sessionId, 2)?.status).toBe(404);
		await initialize();
		expect(sessions.requireSession(retained[1], 2)).toBeNull();
	}
});

it("one user's sessions never end another's with the same client", async () => {
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 2,
		maxSessionsPerUser: 100,
	});
	const initialize = async (userId: string) =>
		(
			await sessions.handleInitialize(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2025-11-25',
						clientInfo: {
							name: 'agent',
							version: '1',
						},
					},
				},
				undefined,
				userId,
			)
		).sessionId;
	const alice = await initialize('alice');
	const bob = [
		await initialize('bob'),
		await initialize('bob'),
		await initialize('bob'),
	];
	expect(sessions.requireSession(alice, 2)).toBeNull();
	expect(sessions.requireSession(bob[0], 2)?.status).toBe(404);
	for (const id of bob.slice(1))
		expect(sessions.requireSession(id, 2)).toBeNull();
});

it("a user's sessions of all clients are limited, without ending another user's", async () => {
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 3,
	});
	const initialize = async (userId: string, name: string) =>
		(
			await sessions.handleInitialize(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion: '2025-11-25',
						clientInfo: {
							name,
							version: '1',
						},
					},
				},
				undefined,
				userId,
			)
		).sessionId;
	const alice = await initialize('alice', 'agent');
	const bob = [];
	for (let index = 0; index < 5; index++)
		bob.push(await initialize('bob', `agent-${index}`));
	expect(sessions.requireSession(alice, 2)).toBeNull();
	for (const id of bob.slice(0, 2))
		expect(sessions.requireSession(id, 2)?.status).toBe(404);
	for (const id of bob.slice(2))
		expect(sessions.requireSession(id, 2)).toBeNull();
	expect(sessions.activeCount()).toBe(4);
});

it('client names over 256 characters or client info over 64 KiB are refused', async () => {
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 100,
	});
	const initialize = (clientInfo: Record<string, unknown>) =>
		sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					clientInfo,
				},
			},
			undefined,
		);
	const name = 'a'.repeat(256);
	expect(
		(
			await initialize({
				name,
				version: name,
				title: name,
			})
		).sessionId,
	).toBeString();
	for (const clientInfo of [
		{
			name: `${name}a`,
			version: '1',
		},
		{
			name: 'agent',
			version: `${name}a`,
		},
		{
			name: 'agent',
			version: '1',
			title: `${name}a`,
		},
		{
			name: 'agent',
			version: '1',
			description: 'ä'.repeat(32 * 1024),
		},
	]) {
		const refused = await initialize(clientInfo);
		expect(refused.sessionId).toBeUndefined();
		expect(refused.status).toBe(400);
	}
	expect(sessions.activeCount()).toBe(1);
});

it('session lifecycle and rejection logs omit transport identifiers', async () => {
	const messages: string[] = [];
	const info = spyOn(logger, 'info').mockImplementation((message) => {
		messages.push(String(message));
	});
	const warn = spyOn(logger, 'warn').mockImplementation((message) => {
		messages.push(String(message));
	});
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 100,
	});
	try {
		const result = await sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					clientInfo: {
						name: 'test',
						version: '1',
					},
				},
			},
			undefined,
		);
		expect(result.sessionId).toBeString();
		sessions.close(result.sessionId);
		sessions.close(result.sessionId);
		sessions.requireSession(result.sessionId, 2);
		sessions.requireSession('unrecognized-transport-id', 3);
		sessions.close('unrecognized-transport-id');
		const output = messages.join('\n');
		expect(output).toContain('client=test@1');
		expect(output).not.toContain(result.sessionId ?? 'missing');
		expect(output).not.toContain('unrecognized-transport-id');
	} finally {
		info.mockRestore();
		warn.mockRestore();
	}
});

it('client activity groups reconnects per protocol and user without exposing sessions', async () => {
	const activity = createClientActivityTracker(3);
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 100,
		onClientActivity: activity.observe,
	});
	const client = {
		name: 'test-client',
		version: '1',
	};
	for (const id of [1, 2]) {
		const result = await sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					clientInfo: client,
				},
			},
			undefined,
		);
		expect(sessions.requireSession(result.sessionId, 2)).toBeNull();
		expect(sessions.close(result.sessionId).status).toBe(202);
		expect(activity.list()).toHaveLength(1);
	}
	const firstSeen = activity.list()[0]?.firstSeen;
	// Another protocol or user is its own entry.
	activity.observe(client, '2026-07-28');
	activity.observe(client, '2026-07-28', 'alice');
	const clients = activity.list();
	const overview = overviewResponseType.assert({
		clients,
		backends: [],
	});
	expect(
		overview.clients.map((entry) => [
			entry.protocolVersion,
			entry.user,
			entry.userId,
		]),
	).toEqual([
		['2026-07-28', 'alice', 'alice'],
		['2026-07-28', undefined, undefined],
		['2025-11-25', undefined, undefined],
	]);
	// The label is the user's current one; the ID stays.
	expect(activity.list(new Map([['alice', 'Alice']]))[0]).toMatchObject({
		user: 'Alice',
		userId: 'alice',
	});
	const entry = overview.clients[2];
	expect(entry).toMatchObject({
		client,
		firstSeen,
		protocolVersion: '2025-11-25',
	});
	expect(entry).not.toHaveProperty('sessionId');
	expect(entry).not.toHaveProperty('status');
	expect(entry).not.toHaveProperty('disconnectedAt');
	// A revisit moves the entry to the front; beyond the limit the oldest goes.
	activity.observe(client, '2025-11-25');
	activity.observe(
		{
			name: 'another-client',
			version: '1',
		},
		'2026-07-28',
	);
	expect(
		activity.list().map((item) => [item.client.name, item.protocolVersion]),
	).toEqual([
		['another-client', '2026-07-28'],
		['test-client', '2025-11-25'],
		['test-client', '2026-07-28'],
	]);
});

it('2025 sessions keep the whole reported client info', async () => {
	const observed: unknown[] = [];
	const sessions = createMcpSessionManager({
		maxSessionsPerClient: 10,
		maxSessionsPerUser: 100,
		onClientActivity: (client) => observed.push(client),
	});
	const clientInfo = {
		name: 'test',
		version: '1',
		title: 'Test',
		description: 'Shown only in traffic',
		icons: [
			{
				src: 'https://example.com/icon.png',
			},
		],
	};
	const result = await sessions.handleInitialize(
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				clientInfo,
			},
		},
		undefined,
	);
	expect(observed).toEqual([clientInfo]);
	expect(sessions.getClient(result.sessionId)).toEqual(clientInfo);
});
