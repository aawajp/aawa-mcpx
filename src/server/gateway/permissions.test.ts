import { createMcpAuth, type McpPrincipal } from '@/server/auth/mcp_auth';
import { createAccessStore } from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { createClientActivityTracker } from '@/server/gateway/client_activity';
import {
	createRouteFixture,
	enabledTools,
	mcpPost,
	toolLookup,
} from '@/server/gateway/route_fixture';
import type { McpUpstreamManager } from '@/server/mcp_upstreams/types';
import {
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	PROTOCOL_VERSION_META,
	protocolHeaders,
} from '@/shared/mcp_protocol';

import { expect, it, mock } from 'bun:test';

const tools = enabledTools('alpha', [
	{
		name: 'one',
		inputSchema: {
			type: 'object',
		},
	},
	{
		name: 'two',
		inputSchema: {
			type: 'object',
		},
	},
]);

const manager = {
	listEnabledTools: () => tools,
	getEnabledTool: toolLookup(tools),
	callTool: async () => ({
		content: [
			{
				type: 'text',
				text: 'done',
			},
		],
	}),
	getStatuses: () => [
		{
			serverName: 'alpha',
			enabled: true,
		},
	],
	listEnabledPrompts: () =>
		new Map([
			[
				'alpha',
				{
					prompts: [
						{
							name: 'greet',
						},
					],
				},
			],
		]),
	getPrompt: async () => ({
		messages: [],
	}),
} as unknown as McpUpstreamManager;

// Alice may use tool "one" and the backend's prompts; Bob may use nothing.
const principals: Record<string, McpPrincipal> = {
	alice: {
		userId: 'alice-id',
		access: {
			allowsBackend: (backend) => backend === 'alpha',
			allowsTool: (backend, tool) => backend === 'alpha' && tool === 'one',
		},
	},
	bob: {
		userId: 'bob-id',
		access: {
			allowsBackend: () => false,
			allowsTool: () => false,
		},
	},
};

const activity = createClientActivityTracker(10);
const { route } = createRouteFixture(manager, {
	onClientActivity: activity.observe,
	authenticate: async (request) =>
		principals[request.headers.get('authorization') ?? ''] ??
		new Response(null, {
			status: 401,
		}),
});

const send = async (
	user: string,
	method: string,
	params: Record<string, unknown>,
	session?: string,
) => {
	const headers = new Headers({
		Authorization: user,
		'MCP-Protocol-Version': '2025-11-25',
	});
	if (session) headers.set('Mcp-Session-Id', session);
	return route.POST(
		mcpPost({
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method,
				params,
			}),
		}),
	);
};

const initialize = async (user: string) =>
	(
		await send(user, 'initialize', {
			protocolVersion: '2025-11-25',
			clientInfo: {
				name: 'permissions-test',
				version: '1',
			},
		})
	).headers.get('Mcp-Session-Id') ?? '';

it('lists show only permitted items and other calls are refused with 403', async () => {
	expect((await send('mallory', 'tools/list', {})).status).toBe(401);
	const alice = await initialize('alice');
	const listed = await (await send('alice', 'tools/list', {}, alice)).json();
	expect(
		listed.result.tools.map((tool: { name: string }) => tool.name),
	).toEqual(['alpha__one']);
	expect(
		(
			await send(
				'alice',
				'tools/call',
				{
					name: 'alpha__one',
				},
				alice,
			)
		).status,
	).toBe(200);
	const refused = await send(
		'alice',
		'tools/call',
		{
			name: 'alpha__two',
		},
		alice,
	);
	expect(refused.status).toBe(403);
	expect((await refused.json()).error.message).toBe(
		'Tool "alpha__two" is not permitted',
	);
	const unknown = await send(
		'alice',
		'tools/call',
		{
			name: 'alpha__three',
		},
		alice,
	);
	expect((await unknown.json()).error.code).toBe(-32602);

	// A session belongs to the user who initialized it.
	expect((await send('bob', 'tools/list', {}, alice)).status).toBe(404);
	const bob = await initialize('bob');
	expect(
		(await (await send('bob', 'tools/list', {}, bob)).json()).result.tools,
	).toEqual([]);
	expect(
		(await (await send('bob', 'prompts/list', {}, bob)).json()).result.prompts,
	).toEqual([]);
	expect(
		(
			await send(
				'bob',
				'prompts/get',
				{
					name: 'alpha__greet',
				},
				bob,
			)
		).status,
	).toBe(403);
});

it('MCP 2026-07-28 requests get the same 403', async () => {
	const params = {
		name: 'alpha__two',
		arguments: {},
		_meta: {
			[PROTOCOL_VERSION_META]: '2026-07-28',
			[CLIENT_CAPABILITIES_META]: {},
		},
	};
	const headers = protocolHeaders('tools/call', params);
	headers.set('Authorization', 'alice');
	const response = await route.POST(
		mcpPost({
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params,
			}),
		}),
	);
	expect(response.status).toBe(403);
});

it('clients show up with their user current name, and refused requests still show the client', async () => {
	const params = {
		_meta: {
			[PROTOCOL_VERSION_META]: '2026-07-28',
			[CLIENT_CAPABILITIES_META]: {},
			[CLIENT_INFO_META]: {
				name: 'activity-test',
				version: '1',
			},
		},
	};
	const discover = (authorization: string) => {
		const headers = protocolHeaders('server/discover', params);
		headers.set('Authorization', authorization);
		return route.POST(
			mcpPost({
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'server/discover',
					params,
				}),
			}),
		);
	};
	expect((await discover('mallory')).status).toBe(401);
	expect((await discover('alice')).status).toBe(200);
	const seen = (userNames?: Map<string, string>) =>
		activity
			.list(userNames)
			.filter((entry) => entry.client.name === 'activity-test')
			.map((entry) => entry.user ?? null);
	// Newest first; the user shows by its current name, else by its ID.
	expect(seen(new Map([['alice-id', 'Alice renamed']]))).toEqual([
		'Alice renamed',
		null,
	]);
	expect(seen()).toEqual(['alice-id', null]);
});

// A Local machine with a role, on one 2025 session through /mcp with its
// API key, against the real access store.
const storeSession = async (backend: McpUpstreamManager) => {
	const access = createAccessStore(openMainDatabase(':memory:'));
	const userId = access.saveUser({
		id: '',
		name: 'bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	const role = access.saveRole({
		name: 'deployers',
		userIds: [userId],
	});
	const { key } = access.createKey({
		userId,
		label: 'test',
	});
	const { route: storeRoute } = createRouteFixture(backend, {
		authenticate: createMcpAuth({
			access,
		}).authenticate,
	});
	let session: string | undefined;
	const call = async (method: string, params: Record<string, unknown>) => {
		const headers = new Headers({
			Authorization: `Bearer ${key}`,
			'MCP-Protocol-Version': '2025-11-25',
		});
		if (session) headers.set('Mcp-Session-Id', session);
		return storeRoute.POST(
			mcpPost({
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method,
					params,
				}),
			}),
		);
	};
	session =
		(
			await call('initialize', {
				protocolVersion: '2025-11-25',
				clientInfo: {
					name: 'store-test',
					version: '1',
				},
			})
		).headers.get('Mcp-Session-Id') ?? undefined;
	// The backend permission is the empty tool.
	const grant = (
		holderType: 'user' | 'role',
		holderId: string,
		tools: string[],
	) =>
		access.savePermissions(
			{
				holderType,
				holderId,
			},
			tools.map((tool) => ({
				backend: 'alpha',
				tool,
			})),
		);
	return {
		userId,
		role,
		call,
		grant,
	};
};

it('permission changes in the store apply to the next request of the same session', async () => {
	const callTool = mock(manager.callTool);
	const { userId, role, call, grant } = await storeSession({
		...manager,
		callTool,
	} as McpUpstreamManager);
	const state = async () => ({
		tools: (await (await call('tools/list', {})).json()).result.tools.map(
			(tool: { name: string }) => tool.name,
		),
		prompts: (await (await call('prompts/list', {})).json()).result.prompts.map(
			(prompt: { name: string }) => prompt.name,
		),
		call: (
			await call('tools/call', {
				name: 'alpha__one',
			})
		).status,
	});
	const revoke = (holderType: 'user' | 'role', holderId: string) =>
		grant(holderType, holderId, []);

	// Through the role: the backend and both tools.
	grant('role', role, ['', 'one', 'two']);
	expect(await state()).toEqual({
		tools: ['alpha__one', 'alpha__two'],
		prompts: ['alpha__greet'],
		call: 200,
	});
	revoke('role', role);
	expect(await state()).toEqual({
		tools: [],
		prompts: [],
		call: 403,
	});
	// Directly: one tool.
	grant('user', userId, ['one']);
	expect(await state()).toEqual({
		tools: ['alpha__one'],
		prompts: [],
		call: 200,
	});
	revoke('user', userId);
	expect((await state()).call).toBe(403);
	// Refused calls never reach the backend.
	expect(callTool).toHaveBeenCalledTimes(2);
});

it('backend permission changes show and hide resources on the same session', async () => {
	const readResource = mock(async () => ({
		contents: [
			{
				uri: 'file:///notes',
				text: 'notes',
			},
		],
	}));
	const { role, call, grant } = await storeSession({
		...manager,
		listEnabledResources: () =>
			new Map([
				[
					'alpha',
					{
						resources: [
							{
								uri: 'file:///notes',
								name: 'notes',
							},
						],
					},
				],
			]),
		listEnabledResourceTemplates: () =>
			new Map([
				[
					'alpha',
					{
						resourceTemplates: [
							{
								uriTemplate: 'file:///{name}',
								name: 'files',
							},
						],
					},
				],
			]),
		readResource,
	} as unknown as McpUpstreamManager);
	const result = async (method: string, params: Record<string, unknown> = {}) =>
		(await (await call(method, params)).json()).result;
	grant('role', role, ['']);
	const [resource] = (await result('resources/list')).resources;
	expect(resource.name).toBe('notes');
	expect(
		(await result('resources/templates/list')).resourceTemplates,
	).toHaveLength(1);
	const read = (uri: string) =>
		call('resources/read', {
			uri,
		});
	expect((await read(resource.uri)).status).toBe(200);
	grant('role', role, []);
	expect((await result('resources/list')).resources).toEqual([]);
	expect((await result('resources/templates/list')).resourceTemplates).toEqual(
		[],
	);
	expect((await read(resource.uri)).status).toBe(403);
	// The refused read never reaches the backend.
	expect(readResource).toHaveBeenCalledTimes(1);
});
