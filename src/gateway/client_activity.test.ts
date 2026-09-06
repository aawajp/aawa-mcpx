import { createClientActivityTracker } from '@/gateway/client_activity';
import { createMcpSessionManager } from '@/gateway/mcp_session';
import { logger } from '@/server/logger';
import { parseClientInfo } from '@/shared/client_info';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/shared/mcp_protocol';
import { overviewResponseType } from '@/shared/ui_api';

test('client info requires name and version when present; omitted identity uses unknown', () => {
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

import { expect, spyOn, test } from 'bun:test';

test('initialization retains the newest sessions per name/version without idle expiration', async () => {
	for (const maxSessionsPerClient of [
		undefined,
		2,
	]) {
		const sessions = createMcpSessionManager({
			maxSessionsPerClient,
			protocolHeaderName: 'MCP-Protocol-Version',
			supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
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
		const limit = maxSessionsPerClient ?? 10;
		for (let index = 0; index < limit; index++)
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
			expect(sessions.requireSession(id, 2, 'tools/list')).toBeNull();
		await sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {},
			},
			undefined,
		);
		expect(sessions.requireSession(retained[0], 2, 'tools/list')).toBeNull();
		const newest = await initialize();
		expect(sessions.requireSession(retained[0], 2, 'tools/list')?.status).toBe(
			404,
		);
		for (const id of [
			...retained.slice(1),
			newest.sessionId,
			otherName.sessionId,
			otherVersion.sessionId,
		])
			expect(sessions.requireSession(id, 2, 'tools/list')).toBeNull();
		expect(sessions.activeCount()).toBe(limit + 2);
		expect(sessions.close(newest.sessionId).status).toBe(202);
		expect(
			sessions.requireSession(newest.sessionId, 2, 'tools/list')?.status,
		).toBe(404);
		await initialize();
		expect(sessions.requireSession(retained[1], 2, 'tools/list')).toBeNull();
	}
});

test('session lifecycle and rejection logs omit transport identifiers', async () => {
	const messages: string[] = [];
	const info = spyOn(logger, 'info').mockImplementation((message) => {
		messages.push(String(message));
	});
	const warn = spyOn(logger, 'warn').mockImplementation((message) => {
		messages.push(String(message));
	});
	const sessions = createMcpSessionManager({
		protocolHeaderName: 'MCP-Protocol-Version',
		supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
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
		sessions.requireSession(result.sessionId, 2, 'tools/list');
		sessions.requireSession('unrecognized-transport-id', 3, 'tools/list');
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

test('client activity groups revisions and reconnects without exposing sessions', async () => {
	const activity = createClientActivityTracker(2);
	const sessions = createMcpSessionManager({
		protocolHeaderName: 'MCP-Protocol-Version',
		supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		onClientActivity: activity.observe,
	});
	const client = {
		name: 'test-client',
		version: '1',
	};
	for (const protocolVersion of [
		'2025-06-18',
		'2025-11-25',
	]) {
		const result = await sessions.handleInitialize(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion,
					clientInfo: client,
				},
			},
			undefined,
		);
		expect(
			sessions.requireSession(result.sessionId, 2, 'tools/list'),
		).toBeNull();
		expect(sessions.close(result.sessionId).status).toBe(202);
		expect(activity.list()).toHaveLength(1);
	}
	const firstSeen = activity.list()[0]?.firstSeen;
	activity.observe(client, '2026-07-28');
	const clients = activity.list();
	const overview = overviewResponseType.assert({
		clients,
		backends: [],
		aggregated: {
			tools: [],
			prompts: [],
			resources: [],
		},
	});
	const entry = overview.clients[0];
	expect(entry).toMatchObject({
		client,
		firstSeen,
		protocolVersion: '2026-07-28',
	});
	expect(entry).not.toHaveProperty('sessionId');
	expect(entry).not.toHaveProperty('status');
	expect(entry).not.toHaveProperty('disconnectedAt');
	activity.observe(
		{
			name: 'test-client',
			version: '2',
		},
		'2026-07-28',
	);
	expect(activity.list()).toHaveLength(2);
	activity.observe(client, '2026-07-28');
	activity.observe(
		{
			name: 'another-client',
			version: '1',
		},
		'2026-07-28',
	);
	expect(activity.list().map((item) => item.client)).toEqual([
		{
			name: 'another-client',
			version: '1',
		},
		client,
	]);
});
