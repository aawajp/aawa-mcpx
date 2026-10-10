import { createRouteFixture, mcpPost } from '@/server/gateway/route_fixture';
import { createMcpUpstreamBackend } from '@/server/mcp_upstreams/connections';
import { createInputSchemaCompiler } from '@/server/mcp_upstreams/input_schema';
import { createMcpUpstreamOperations } from '@/server/mcp_upstreams/method_calls';
import { ProtocolClient } from '@/server/mcp_upstreams/protocol_client';
import { startFixtureBackend } from '@/server/mcp_upstreams/protocol_fixture';
import type {
	CallToolParams,
	McpUpstreamManager,
	McpUpstreamServer,
} from '@/server/mcp_upstreams/types';
import { addResourcePrefix } from '@/shared/mcp_namespaces';
import {
	CLIENT_CAPABILITIES_META,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	type ProtocolVersion,
	protocolHeaders,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

import { expect, mock, test } from 'bun:test';

const until = async (
	condition: () => boolean | Promise<boolean>,
): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await condition()) return;
		await Bun.sleep(5);
	}
	throw new Error('Cancellation fixture did not reach the expected state');
};

const gateway = (
	manager: McpUpstreamManager,
	refreshCatalogs?: () => Promise<void>,
) => {
	const { route } = createRouteFixture(manager, {
		refreshCatalogs,
	});
	const send = (
		version: ProtocolVersion,
		session: string | undefined,
		method: string,
		fields: Record<string, unknown> = {},
		id?: string | number,
		signal?: AbortSignal,
	) => {
		const params =
			version === CURRENT_PROTOCOL_VERSION
				? {
						...fields,
						_meta: {
							...recordOf(fields._meta),
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					}
				: fields;
		const headers =
			version === CURRENT_PROTOCOL_VERSION
				? protocolHeaders(method, params)
				: new Headers({
						'MCP-Protocol-Version': version,
					});
		if (session) headers.set('Mcp-Session-Id', session);
		return mcpPost({
			headers,
			signal,
			body: JSON.stringify({
				jsonrpc: '2.0',
				...(id === undefined
					? {}
					: {
							id,
						}),
				method,
				params,
			}),
		});
	};
	const initialize = async (version: ProtocolVersion): Promise<string> => {
		const response = await route.POST(
			send(
				version,
				undefined,
				'initialize',
				{
					protocolVersion: version,
					capabilities: {},
					clientInfo: {
						name: 'cancel-test',
						version: '1',
					},
				},
				100,
			),
		);
		return response.headers.get('Mcp-Session-Id') ?? '';
	};
	return {
		route,
		send,
		initialize,
	};
};

for (const backendVersion of SUPPORTED_PROTOCOL_VERSIONS)
	for (const transport of [
		'http',
		'stdio',
	] as const)
		test(`${backendVersion} ${transport}: cancellation translates every client revision and preserves connection health`, async () => {
			const received: Record<string, unknown>[] = [];
			const cancellationHeaders = new Map<unknown, Headers>();
			let disconnected = 0;
			const sessionHeaders = (method: unknown): Record<string, string> =>
				method === 'initialize'
					? {
							'Mcp-Session-Id': 'backend-session',
						}
					: {};
			const backend = startFixtureBackend(transport, backendVersion, {
				cancellation: true,
				handle: (message, reply, request) => {
					received.push(message);
					if (message.method === 'notifications/cancelled')
						cancellationHeaders.set(
							recordOf(message.params)?.requestId,
							request.headers,
						);
					if (!reply) return undefined;
					if (
						!(
							recordOf(recordOf(message.params)?.arguments)?.fixtureMode ===
								'delayed' ||
							recordOf(message.params)?.fixtureDelay ||
							recordOf(recordOf(message.params)?._meta)?.['com.example/delayed']
						)
					)
						return Response.json(reply, {
							headers: sessionHeaders(message.method),
						});
					let timer: ReturnType<typeof setTimeout>;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(': started\n\n'));
								timer = setTimeout(() => {
									controller.enqueue(
										new TextEncoder().encode(
											`data: ${JSON.stringify(reply)}\n\n`,
										),
									);
									controller.close();
								}, 2000);
							},
							cancel() {
								clearTimeout(timer);
								disconnected++;
							},
						}),
						{
							headers: {
								'Content-Type': 'text/event-stream',
								...sessionHeaders(message.method),
							},
						},
					);
				},
			});
			const server: McpUpstreamServer = {
				serverName: 'backend',
				serverConfig: {
					...backend.config,
					enabled: true,
					timeout: 3000,
					trafficLimit: 1000,
				},
			};
			const client = new ProtocolClient(server, backendVersion);
			const recovery = mock(() => undefined);
			client.ontransporterror = recovery;
			const compiled = createInputSchemaCompiler()({
				type: 'object',
			});
			if ('issue' in compiled) throw new Error(compiled.issue.detail);
			const operations = createMcpUpstreamOperations({
				getBackend: () => ({
					...createMcpUpstreamBackend(server),
					client,
				}),
				getEnabledTool: ({ toolName }) =>
					toolName === 'echo'
						? {
								tool: {
									name: 'echo',
									inputSchema: {
										type: 'object',
									},
								},
								inputValidator: compiled,
							}
						: undefined,
				waitForRateLimit: async () => undefined,
			});
			const manager = {
				...operations,
				listEnabledTools: () => new Map(),
			} as unknown as McpUpstreamManager;
			const { route, send, initialize } = gateway(manager);
			const events = async (): Promise<Record<string, unknown>[]> => {
				if (transport === 'http') return received;
				const reply = await client.callTool({
					name: 'echo',
					arguments: {
						fixtureMode: 'events',
					},
				});
				return (recordOf(reply.structuredContent)?.events ?? []) as Record<
					string,
					unknown
				>[];
			};
			try {
				await client.connect();
				if (backendVersion !== CURRENT_PROTOCOL_VERSION) {
					const controller = new AbortController();
					const operation = client.rpc(
						'initialize',
						{
							fixtureDelay: true,
						},
						{
							signal: controller.signal,
						},
					);
					const rejected = operation.catch((error: unknown) => error);
					let initializeId: unknown;
					await until(async () => {
						initializeId = (await events()).find(
							(message) => recordOf(message.params)?.fixtureDelay,
						)?.id;
						return initializeId !== undefined;
					});
					controller.abort();
					expect(await rejected).toBeInstanceOf(Error);
					await Bun.sleep(5);
					expect(
						(await events()).some(
							(message) =>
								message.method === 'notifications/cancelled' &&
								recordOf(message.params)?.requestId === initializeId,
						),
					).toBe(false);
				}
				for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
					const session =
						version === CURRENT_PROTOCOL_VERSION
							? undefined
							: await initialize(version);
					for (const [method, fields] of [
						[
							'tools/call',
							{
								name: 'backend__echo',
								arguments: {},
							},
						],
						[
							'prompts/get',
							{
								name: 'backend__greet',
								arguments: {},
							},
						],
						[
							'resources/read',
							{
								uri: addResourcePrefix({
									serverName: 'backend',
									uri: 'file:///example',
								}),
							},
						],
					] as const) {
						const token = `${version}:${method}`;
						const controller = new AbortController();
						const request = send(
							version,
							session,
							method,
							{
								...fields,
								_meta: {
									'com.example/delayed': token,
								},
							},
							'public-id',
							controller.signal,
						);
						const operation = route.POST(request);
						let backendId: unknown;
						await until(async () => {
							backendId = (await events()).find(
								(message) =>
									recordOf(recordOf(message.params)?._meta)?.[
										'com.example/delayed'
									] === token,
							)?.id;
							return backendId !== undefined;
						});
						if (version === CURRENT_PROTOCOL_VERSION) controller.abort();
						else {
							// A legacy disconnect must not cancel; an explicit notification does.
							controller.abort();
							await Bun.sleep(5);
							expect(
								(await events()).some(
									(message) =>
										message.method === 'notifications/cancelled' &&
										recordOf(message.params)?.requestId === backendId,
								),
							).toBe(false);
							expect(
								(
									await route.POST(
										send(version, session, 'notifications/cancelled', {
											requestId: 'public-id',
										}),
									)
								).status,
							).toBe(202);
						}
						const response = await operation;
						expect(response.headers.get('Content-Type')).toBe(
							'text/event-stream',
						);
						expect(await response.text()).toBe('');
						if (
							transport === 'stdio' ||
							backendVersion !== CURRENT_PROTOCOL_VERSION
						) {
							await until(async () =>
								(await events()).some(
									(message) =>
										message.method === 'notifications/cancelled' &&
										recordOf(message.params)?.requestId === backendId,
								),
							);
							const notifications = (await events()).filter(
								(message) =>
									message.method === 'notifications/cancelled' &&
									recordOf(message.params)?.requestId === backendId,
							);
							expect(notifications).toHaveLength(1);
							expect(backendId).not.toBe('public-id');
							if (transport === 'http') {
								expect(
									cancellationHeaders
										.get(backendId)
										?.get('MCP-Protocol-Version'),
								).toBe(backendVersion);
								expect(
									cancellationHeaders.get(backendId)?.get('Mcp-Session-Id'),
								).toBe('backend-session');
							}
						} else {
							await until(() => disconnected > 0);
							expect(
								(await events()).filter(
									(message) => message.method === 'notifications/cancelled',
								),
							).toHaveLength(0);
						}
					}
				}
				// The fixture emits abandoned stdio replies anyway; the connection and
				// subsequent request must remain usable and retain their own IDs.
				await Bun.sleep(120);
				expect(
					(
						await client.callTool({
							name: 'echo',
							arguments: {
								text: 'healthy',
							},
						})
					).content,
				).toEqual([
					{
						type: 'text',
						text: 'healthy',
					},
				]);
				expect(recovery).not.toHaveBeenCalled();
			} finally {
				await client.close();
				backend.stop();
			}
		});

for (const version of [
	'2025-06-18',
	'2025-11-25',
] as const)
	test(`${version}: cancellation isolates sessions and typed IDs, ignores invalid/completed IDs and protects initialize`, async () => {
		const signals: AbortSignal[] = [];
		const gates: (() => void)[] = [];
		const callTool = mock(async (params: CallToolParams) => {
			if (!params.signal) throw new Error('Missing cancellation signal');
			signals.push(params.signal);
			await new Promise<void>((resolve) => gates.push(resolve));
			return {
				content: [],
			};
		});
		const { route, send, initialize } = gateway({
			callTool,
			listEnabledTools: () => new Map(),
		} as unknown as McpUpstreamManager);
		const first = await initialize(version);
		const second = await initialize(version);
		const fields = {
			name: 'backend__echo',
			arguments: {},
		};
		const calls = [
			route.POST(send(version, first, 'tools/call', fields, 0)),
			route.POST(send(version, first, 'tools/call', fields, '0')),
			route.POST(send(version, second, 'tools/call', fields, 0)),
		];
		await until(() => signals.length === 3);
		const duplicate = await route.POST(
			send(version, first, 'tools/call', fields, 0),
		);
		expect(recordOf(recordOf(await duplicate.json())?.error)?.code).toBe(
			-32600,
		);
		for (const params of [
			{
				requestId: 999,
			},
			{
				requestId: 0.5,
			},
			{
				requestId: null,
			},
			{
				requestId: 0,
				reason: false,
			},
			{
				requestId: 100,
			},
		])
			expect(
				(
					await route.POST(
						send(version, first, 'notifications/cancelled', params),
					)
				).status,
			).toBe(202);
		expect(signals.every((signal) => !signal.aborted)).toBe(true);
		await route.POST(
			send(version, first, 'notifications/cancelled', {
				requestId: 0,
			}),
		);
		expect(signals.map((signal) => signal.aborted)).toEqual([
			true,
			false,
			false,
		]);
		expect(await (await calls[0])?.text()).toBe('');
		for (const resolve of gates) resolve();
		expect((await calls[1])?.status).toBe(200);
		expect((await calls[2])?.status).toBe(200);
		await route.POST(
			send(version, first, 'notifications/cancelled', {
				requestId: '0',
			}),
		);
		expect(signals[1]?.aborted).toBe(false);
	});

test('cancelling during a shared catalog refresh prevents dispatch without cancelling the refresh', async () => {
	const gate = Promise.withResolvers<void>();
	const callTool = mock(async () => ({
		content: [],
	}));
	const { route, send, initialize } = gateway(
		{
			callTool,
		} as unknown as McpUpstreamManager,
		() => gate.promise,
	);
	const session = await initialize('2025-11-25');
	const request = route.POST(
		send(
			'2025-11-25',
			session,
			'tools/call',
			{
				name: 'backend__echo',
				arguments: {},
			},
			1,
		),
	);
	await Bun.sleep(5);
	await route.POST(
		send('2025-11-25', session, 'notifications/cancelled', {
			requestId: 1,
		}),
	);
	try {
		expect(await (await request).text()).toBe('');
	} finally {
		gate.resolve();
	}
	await Bun.sleep(5);
	expect(callTool).not.toHaveBeenCalled();
});

test('a real modern HTTP disconnect aborts backend dispatch', async () => {
	const observed = Promise.withResolvers<AbortSignal>();
	const finished = Promise.withResolvers<void>();
	const { route, send } = gateway({
		callTool: async (params: CallToolParams) => {
			if (!params.signal) throw new Error('Missing signal');
			observed.resolve(params.signal);
			await new Promise<void>((resolve) =>
				params.signal?.addEventListener(
					'abort',
					() => {
						resolve();
						finished.resolve();
					},
					{
						once: true,
					},
				),
			);
			return {
				content: [],
			};
		},
		listEnabledTools: () => new Map(),
	} as unknown as McpUpstreamManager);
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: route.POST,
	});
	const controller = new AbortController();
	const template = send(
		CURRENT_PROTOCOL_VERSION,
		undefined,
		'tools/call',
		{
			name: 'backend__echo',
			arguments: {},
		},
		1,
	);
	const operation = fetch(server.url, {
		method: 'POST',
		headers: template.headers,
		body: await template.text(),
		signal: controller.signal,
	}).catch(() => undefined);
	try {
		const signal = await observed.promise;
		controller.abort();
		await until(() => signal.aborted);
		await finished.promise;
		await operation;
	} finally {
		controller.abort();
		server.stop(true);
	}
});
