import type { Tool } from '@modelcontextprotocol/sdk/types';

import { createRouteFixture, mcpPost } from '@/gateway/route_fixture';
import { createOutputSchemaValidator } from '@/mcp_upstreams/output_schema';
import { BackendRpcError } from '@/mcp_upstreams/protocol_client';
import { createToolResultNormalizer } from '@/mcp_upstreams/tool_result';
import type { CatalogRequest, McpUpstreamManager } from '@/mcp_upstreams/types';
import {
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	recordOf,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';

import { expect, mock, test } from 'bun:test';

const fixture = () => {
	let refreshes = 0;
	const refreshCatalogs = async (request: CatalogRequest): Promise<void> => {
		refreshes++;
		await manager.refreshStaleCatalogs?.(request);
	};
	const manager = {
		listEnabledTools: () =>
			new Map([
				[
					'backend',
					{
						tools: [
							{
								name: 'echo',
								inputSchema: {
									type: 'object',
								},
							},
						],
					},
				],
			]),
		callTool: async (params: { args: Record<string, unknown> }) => ({
			content: [
				{
					type: 'text',
					text: String(params.args.text),
				},
			],
		}),
	} as unknown as McpUpstreamManager;
	const { route, sessions } = createRouteFixture(manager, {
		refreshCatalogs,
	});
	return {
		route,
		sessions,
		manager,
		refreshCount: () => refreshes,
	};
};

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`public ${version}: metadata reaches calls and unsupported options respect revision rules`, async () => {
		const { route, manager } = fixture();
		const callTool = mock(manager.callTool);
		manager.callTool = callTool;
		let session: string | null = null;
		const send = async (
			method: string,
			fields: Record<string, unknown>,
			_meta?: unknown,
		) => {
			const body = {
				...fields,
				...(_meta === undefined
					? {}
					: {
							_meta,
						}),
			};
			const headers =
				version === CURRENT_PROTOCOL_VERSION
					? protocolHeaders(method, body)
					: new Headers({
							'MCP-Protocol-Version': version,
						});
			if (session) headers.set('Mcp-Session-Id', session);
			return route.POST(
				mcpPost({
					headers,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method,
						params: body,
					}),
				}),
			);
		};
		if (version !== CURRENT_PROTOCOL_VERSION) {
			const initialized = await send('initialize', {
				protocolVersion: version,
				capabilities: {},
				clientInfo: {
					name: 'metadata',
					version: '1',
				},
			});
			session = initialized.headers.get('Mcp-Session-Id');
		}
		const metadata = {
			'com.example/context': {
				locale: 'ja',
			},
			progressToken: 0,
			...(version === CURRENT_PROTOCOL_VERSION
				? {
						[PROTOCOL_VERSION_META]: version,
						[CLIENT_CAPABILITIES_META]: {},
					}
				: {}),
		};
		const fields = {
			name: 'backend__echo',
			arguments: {},
		};
		expect((await send('tools/call', fields, metadata)).status).toBe(200);
		expect(callTool.mock.calls[0]?.[0]).toMatchObject({
			metadata,
		});
		const continued = await send(
			'tools/call',
			{
				...fields,
				requestState: null,
			},
			metadata,
		);
		expect((await continued.json()).error.code).toBe(-32602);
		if (version === CURRENT_PROTOCOL_VERSION) {
			const discovery = await send(
				'server/discover',
				{
					inputResponses: [],
				},
				metadata,
			);
			expect(discovery.status).toBe(400);
			expect((await discovery.json()).error.code).toBe(-32602);
		}
		const task = await send(
			'tools/call',
			{
				...fields,
				task: {
					ttl: 60000,
				},
			},
			metadata,
		);
		const reply = await task.json();
		if (version === '2025-11-25') {
			expect(reply.result).toBeDefined();
			expect(callTool).toHaveBeenCalledTimes(2);
		} else {
			expect(reply.error.code).toBe(-32602);
			expect(callTool).toHaveBeenCalledTimes(1);
		}
		const invalid = await send('tools/call', fields, {
			...metadata,
			progressToken: 1.5,
		});
		expect((await invalid.json()).error.code).toBe(-32602);
		expect(callTool).toHaveBeenCalledTimes(version === '2025-11-25' ? 2 : 1);
	});

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`public ${version}: lifecycle, list and call`, async () => {
		const { route, manager, refreshCount } = fixture();
		let session: string | null = null;
		const send = async (
			method: string,
			params: Record<string, unknown> = {},
		) => {
			const usesRequestMetadata = version === CURRENT_PROTOCOL_VERSION;
			const body = usesRequestMetadata
				? {
						...params,
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					}
				: params;
			const headers = usesRequestMetadata
				? protocolHeaders(method, body)
				: new Headers({
						'MCP-Protocol-Version': version,
					});
			if (session) headers.set('Mcp-Session-Id', session);
			return route.POST(
				mcpPost({
					headers,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method,
						params: body,
					}),
				}),
			);
		};
		if (version !== CURRENT_PROTOCOL_VERSION) {
			const initial = await send('initialize', {
				protocolVersion: version,
				clientInfo: {
					name: 'test',
					version: '1',
				},
				capabilities: {},
			});
			session = initial.headers.get('Mcp-Session-Id');
			expect(session).toBeTruthy();
			expect(recordOf((await initial.json()).result)?.protocolVersion).toBe(
				version,
			);
		}
		const list = await send('tools/list');
		expect(list.status).toBe(200);
		expect(refreshCount()).toBe(1);
		const result = recordOf((await list.json()).result);
		expect(result?.tools).toEqual([
			{
				name: 'backend__echo',
				description: '[backend]',
				inputSchema: {
					type: 'object',
				},
			},
		]);
		const call = await send('tools/call', {
			name: 'backend__echo',
			arguments: {
				text: 'works',
			},
		});
		expect((await call.json()).result.content).toEqual([
			{
				type: 'text',
				text: 'works',
			},
		]);
		if (version === CURRENT_PROTOCOL_VERSION) {
			expect(list.headers.has('Mcp-Session-Id')).toBe(false);
			expect(result).toMatchObject({
				resultType: 'complete',
				ttlMs: 0,
				cacheScope: 'private',
			});
			expect((await send('ping')).status).toBe(404);
		}
		manager.callTool = async () => {
			throw new BackendRpcError('Missing tool', -32601, {
				tool: 'echo',
			});
		};
		const failure = await send('tools/call', {
			name: 'backend__echo',
		});
		expect(failure.status).toBe(
			version === CURRENT_PROTOCOL_VERSION ? 404 : 200,
		);
		expect((await failure.json()).error).toEqual({
			code: -32601,
			message: 'Missing tool',
			data: {
				tool: 'echo',
			},
		});
	});

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`public ${version}: output schema and structured result agree after adaptation`, async () => {
		const { route, manager } = fixture();
		const schema = {
			type: [
				'object',
				'array',
				'null',
				'string',
				'number',
				'boolean',
			],
			$defs: {
				item: {
					type: 'integer',
				},
			},
			properties: {
				count: {
					$ref: '#/$defs/item',
				},
			},
			items: {
				$ref: '#/$defs/item',
			},
		};
		let outputSchema: unknown = schema;
		manager.listEnabledTools = () =>
			new Map([
				[
					'backend',
					{
						tools: [
							{
								name: 'echo',
								inputSchema: {
									type: 'object',
								},
								outputSchema: outputSchema as Tool['outputSchema'],
							},
						],
					},
				],
			]);
		let backendResult: ToolCallResult = {
			content: [],
			structuredContent: {
				count: 2,
			},
		};
		const normalize = createToolResultNormalizer();
		manager.callTool = async () =>
			normalize(backendResult, outputSchema, {
				backend: 'backend',
				tool: 'echo',
			});
		let session: string | undefined;
		const send = async (
			method: string,
			params: Record<string, unknown> = {},
		): Promise<Response> => {
			const body =
				version === CURRENT_PROTOCOL_VERSION
					? {
							...params,
							_meta: {
								[PROTOCOL_VERSION_META]: version,
								[CLIENT_CAPABILITIES_META]: {},
							},
						}
					: params;
			const headers =
				version === CURRENT_PROTOCOL_VERSION
					? protocolHeaders(method, body)
					: new Headers({
							'MCP-Protocol-Version': version,
						});
			if (session) headers.set('Mcp-Session-Id', session);
			return route.POST(
				mcpPost({
					headers,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method,
						params: body,
					}),
				}),
			);
		};
		if (version !== CURRENT_PROTOCOL_VERSION) {
			const response = await send('initialize', {
				protocolVersion: version,
				clientInfo: {
					name: 'schema-test',
					version: '1',
				},
				capabilities: {},
			});
			session = response.headers.get('Mcp-Session-Id') ?? undefined;
		}
		const catalog = await (await send('tools/list')).json();
		const advertisedSchema: unknown = catalog.result.tools[0].outputSchema;
		expect(recordOf(advertisedSchema)?.type).toEqual(
			version === CURRENT_PROTOCOL_VERSION ? schema.type : 'object',
		);
		const validate = createOutputSchemaValidator();
		const values = [
			{
				count: 2,
			},
			{},
			[
				1,
				2,
			],
			[],
			'hello',
			'',
			3.5,
			0,
			true,
			false,
			null,
		];
		const independentContent: ToolCallResult['content'] = [
			{
				type: 'text',
				text: 'Independent diagnostic message.',
			},
			{
				type: 'text',
				text: '{"supplementary":"backend context"}',
			},
			{
				type: 'image',
				data: 'aW1hZ2U=',
				mimeType: 'image/png',
			},
			{
				type: 'resource_link',
				name: 'report',
				uri: 'file:///report',
			},
		];
		for (const structuredContent of values) {
			backendResult = {
				content: [
					{
						type: 'text',
						text: JSON.stringify(structuredContent),
					},
					...independentContent,
				],
				structuredContent,
				_meta: {
					trace: 'schema-test',
				},
			};
			const result = (
				await (
					await send('tools/call', {
						name: 'backend__echo',
					})
				).json()
			).result;
			expect(result.content).toEqual([
				...independentContent.slice(0, 3),
				{
					type: 'resource_link',
					name: 'report',
					uri: 'aawa-mcpx://resource/backend/file%3A%2F%2F%2Freport',
				},
			]);
			expect(result._meta).toMatchObject({
				trace: 'schema-test',
			});
			expect(result.structuredContent).toEqual(
				version === CURRENT_PROTOCOL_VERSION
					? structuredContent
					: {
							value: structuredContent,
						},
			);
			expect(
				validate(advertisedSchema, result.structuredContent),
			).toBeUndefined();
		}

		// Schema-free results wrap only non-objects for either 2025 revision.
		outputSchema = undefined;
		const schemaFreeCatalog = await (await send('tools/list')).json();
		expect(schemaFreeCatalog.result.tools[0].outputSchema).toBeUndefined();
		for (const structuredContent of values) {
			for (const recover of [
				false,
				true,
			]) {
				backendResult = {
					content: [
						{
							type: 'text',
							text: JSON.stringify(structuredContent),
						},
					],
					...(recover
						? {}
						: {
								structuredContent,
							}),
				};
				const result = (
					await (
						await send('tools/call', {
							name: 'backend__echo',
						})
					).json()
				).result;
				expect(result.content).toEqual([]);
				expect(result.structuredContent).toEqual(
					version === CURRENT_PROTOCOL_VERSION || recordOf(structuredContent)
						? structuredContent
						: {
								value: structuredContent,
							},
				);
			}
		}

		// Object-only schemas and values remain unchanged on all revisions.
		outputSchema = {
			type: 'object',
			properties: {
				count: {
					type: 'integer',
				},
			},
			required: [
				'count',
			],
		};
		backendResult = {
			content: [],
			structuredContent: {
				count: 2,
			},
		};
		const objectCatalog = await (await send('tools/list')).json();
		expect(objectCatalog.result.tools[0].outputSchema).toEqual(outputSchema);
		const objectResult = (
			await (
				await send('tools/call', {
					name: 'backend__echo',
				})
			).json()
		).result;
		expect(objectResult.structuredContent).toEqual({
			count: 2,
		});
		expect(
			validate(
				objectCatalog.result.tools[0].outputSchema,
				objectResult.structuredContent,
			),
		).toBeUndefined();
	});

test('initialize proposals choose a supported alternative and enforce stored version', async () => {
	const { sessions } = fixture();
	for (const protocolVersion of [
		'2025-06-18',
		'2025-11-25',
	]) {
		for (const clientInfo of [
			undefined,
			{
				name: 'test',
			},
			{
				version: '1',
			},
		]) {
			const rejected = await sessions.handleInitialize(
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						protocolVersion,
						clientInfo,
					},
				},
				undefined,
			);
			expect(rejected.status).toBe(400);
		}
	}
	const initial = await sessions.handleInitialize(
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				clientInfo: {
					name: 'test',
					version: '1',
				},
			},
		},
		undefined,
	);
	expect(
		initial.payload &&
			'result' in initial.payload &&
			initial.payload.result.protocolVersion,
	).toBe('2025-11-25');
	expect(
		sessions.validateProtocolHeader(
			new Request('http://localhost', {
				headers: {
					'MCP-Protocol-Version': '2025-06-18',
				},
			}),
			initial.sessionId,
			2,
			'tools/list',
		)?.status,
	).toBe(400);
	expect(
		sessions.validateProtocolHeader(
			new Request('http://localhost'),
			initial.sessionId,
			2,
			'tools/list',
		),
	).toBeNull();
});

test('2026-07-28 header failures, unsupported version, and irrelevant sessions', async () => {
	const { route } = fixture();
	const send = (version: string, methodHeader?: string) =>
		route.POST(
			mcpPost({
				headers: {
					'MCP-Protocol-Version': version,
					...(methodHeader
						? {
								'Mcp-Method': methodHeader,
							}
						: {}),
					'Mcp-Session-Id': 'irrelevant',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'server/discover',
					params: {
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					},
				}),
			}),
		);
	expect((await (await send(CURRENT_PROTOCOL_VERSION)).json()).error.code).toBe(
		-32020,
	);
	expect(
		(await (await send('2099-01-01', 'server/discover')).json()).error,
	).toMatchObject({
		code: -32022,
		data: {
			requested: '2099-01-01',
			supported: [
				...SUPPORTED_PROTOCOL_VERSIONS,
			],
		},
	});
	const response = await send(CURRENT_PROTOCOL_VERSION, 'server/discover');
	expect(response.headers.has('Mcp-Session-Id')).toBe(false);
	expect((await response.json()).result.supportedVersions).toEqual([
		...SUPPORTED_PROTOCOL_VERSIONS,
	]);
});

test('modern metadata validates per request without requiring or inheriting optional capabilities', async () => {
	const { route, manager, refreshCount } = fixture();
	const invoke = mock(manager.callTool);
	manager.callTool = invoke;
	const valid = {
		[PROTOCOL_VERSION_META]: CURRENT_PROTOCOL_VERSION,
		[CLIENT_CAPABILITIES_META]: {},
	};
	const send = (
		metadata: unknown,
		headers: HeadersInit = {
			'MCP-Protocol-Version': CURRENT_PROTOCOL_VERSION,
			'Mcp-Method': 'server/discover',
		},
		method = 'server/discover',
	) =>
		route.POST(
			mcpPost({
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method,
					params: {
						_meta: metadata,
					},
				}),
			}),
		);
	for (const metadata of [
		undefined,
		null,
		[],
		{},
		{
			[CLIENT_CAPABILITIES_META]: {},
		},
		{
			...valid,
			[PROTOCOL_VERSION_META]: 1,
		},
		{
			...valid,
			[CLIENT_CAPABILITIES_META]: null,
		},
		{
			...valid,
			[CLIENT_CAPABILITIES_META]: [],
		},
		...[
			{
				roots: false,
			},
			{
				sampling: [],
			},
			{
				sampling: {
					tools: true,
				},
			},
			{
				elicitation: {
					form: false,
				},
			},
			{
				experimental: {
					custom: [],
				},
			},
			{
				extensions: {
					'com.example/ui': null,
				},
			},
			{
				extensions: {
					unprefixed: {},
				},
			},
		].map((capabilities) => ({
			...valid,
			[CLIENT_CAPABILITIES_META]: capabilities,
		})),
		{
			...valid,
			[CLIENT_INFO_META]: {
				name: 'incomplete',
			},
		},
		{
			...valid,
			[CLIENT_INFO_META]: {
				name: 'test',
				version: '1',
				description: 42,
			},
		},
		{
			...valid,
			'io.modelcontextprotocol/logLevel': 'verbose',
		},
		{
			...valid,
			progressToken: [],
		},
		{
			...valid,
			progressToken: 1.5,
		},
		{
			...valid,
			'invalid key': true,
		},
	]) {
		const response = await send(metadata);
		expect(response.status).toBe(400);
		expect((await response.json()).error.code).toBe(-32602);
	}
	// Omitted metadata is malformed even when discovery has no version header.
	expect((await (await send(undefined, {})).json()).error.code).toBe(-32602);
	const missingHeader = await send(valid, {
		'Mcp-Method': 'server/discover',
	});
	expect((await missingHeader.json()).error.code).toBe(-32020);
	const capable = {
		...valid,
		[CLIENT_INFO_META]: {
			name: 'capable',
			version: '1',
			title: 'Client',
		},
		[CLIENT_CAPABILITIES_META]: {
			sampling: {
				tools: {},
			},
			elicitation: {
				form: {},
				url: {},
			},
			extensions: {
				'com.example/ui': {
					mimeTypes: [
						'text/html',
					],
				},
			},
		},
	};
	expect((await send(capable)).status).toBe(200);
	expect((await send(valid)).status).toBe(200);
	// No capabilities are needed by the implemented complete-result methods.
	expect(
		(
			await send(
				valid,
				protocolHeaders('tools/list', {
					_meta: valid,
				}),
				'tools/list',
			)
		).status,
	).toBe(200);
	expect(refreshCount()).toBe(1);
	expect(invoke).not.toHaveBeenCalled();
});

test('modern mirrors use refreshed rules exactly once and reject recognized surplus headers', async () => {
	const { route, manager, refreshCount } = fixture();
	let schema: Tool['inputSchema'] = {
		type: 'object',
		properties: {
			count: {
				type: 'integer',
				'x-mcp-header': 'Old',
			},
		},
	};
	manager.listEnabledTools = () =>
		new Map([
			[
				'backend',
				{
					tools: [
						{
							name: 'echo',
							inputSchema: schema,
						},
					],
				},
			],
		]);
	manager.refreshStaleCatalogs = async () => {
		schema = {
			type: 'object',
			properties: {
				count: {
					type: 'integer',
					'x-mcp-header': 'Count',
				},
				flag: {
					type: 'boolean',
					'x-mcp-header': 'Flag',
				},
			},
		};
	};
	const invoke = mock(manager.callTool);
	manager.callTool = invoke;
	const send = (
		args: Record<string, unknown>,
		mirrors: Record<string, string>,
	) => {
		const body = {
			name: 'backend__echo',
			arguments: args,
			_meta: {
				[PROTOCOL_VERSION_META]: CURRENT_PROTOCOL_VERSION,
				[CLIENT_CAPABILITIES_META]: {},
			},
		};
		const headers = protocolHeaders('tools/call', body);
		for (const [name, value] of Object.entries(mirrors))
			headers.set(`Mcp-Param-${name}`, value);
		return route.POST(
			mcpPost({
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: body,
				}),
			}),
		);
	};
	const response = await send(
		{
			count: 42,
			flag: false,
		},
		{
			Count: '42.0',
			Flag: 'false',
			Opaque: 'forward me',
		},
	);
	expect(response.status).toBe(200);
	expect(refreshCount()).toBe(1);
	expect(invoke).toHaveBeenCalledTimes(1);
	expect(invoke.mock.calls[0]?.[0]).toMatchObject({
		mirroredHeaders: {
			'mcp-param-count': '42.0',
			'mcp-param-flag': 'false',
			'mcp-param-opaque': 'forward me',
		},
	});
	for (const [args, mirrors] of [
		[
			{
				count: 42,
			},
			{
				Old: '42',
			},
		],
		[
			{
				count: 42,
			},
			{
				Count: '43',
			},
		],
		[
			{},
			{
				Count: '0',
			},
		],
		[
			{
				count: null,
			},
			{
				Count: '0',
			},
		],
		[
			{
				flag: false,
			},
			{
				Flag: 'TRUE',
			},
		],
	] as const) {
		const failed = await send(args, mirrors);
		expect(failed.status).toBe(400);
		expect((await failed.json()).error.code).toBe(-32020);
	}
	expect(invoke).toHaveBeenCalledTimes(1);
	manager.refreshStaleCatalogs = async () => {
		throw new Error('Refresh failed');
	};
	const failedRefresh = await send({}, {});
	expect(failedRefresh.status).toBe(500);
	expect((await failedRefresh.json()).error.code).toBe(-32603);
});

for (const version of SUPPORTED_PROTOCOL_VERSIONS)
	test(`${version}: malformed header annotations affect only modern public HTTP tools`, async () => {
		const { route, manager } = fixture();
		const invoke = mock(manager.callTool);
		manager.callTool = invoke;
		manager.listEnabledTools = () =>
			new Map([
				[
					'backend',
					{
						tools: [
							{
								name: 'echo',
								inputSchema: {
									type: 'object',
								},
							},
							{
								name: 'bad',
								inputSchema: {
									type: 'object',
									properties: {
										value: {
											type: 'number',
											'x-mcp-header': 'Value',
										},
									},
								},
							},
						],
					},
				],
			]);
		let session: string | null = null;
		const send = (method: string, params: Record<string, unknown> = {}) => {
			const modern = version === CURRENT_PROTOCOL_VERSION;
			const body = modern
				? {
						...params,
						_meta: {
							[PROTOCOL_VERSION_META]: version,
							[CLIENT_CAPABILITIES_META]: {},
						},
					}
				: params;
			const headers = modern
				? protocolHeaders(method, body)
				: new Headers({
						'MCP-Protocol-Version': version,
					});
			if (session) headers.set('Mcp-Session-Id', session);
			return route.POST(
				mcpPost({
					headers,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method,
						params: body,
					}),
				}),
			);
		};
		if (version !== CURRENT_PROTOCOL_VERSION)
			session = (
				await send('initialize', {
					protocolVersion: version,
					clientInfo: {
						name: 'legacy',
						version: '1',
					},
				})
			).headers.get('Mcp-Session-Id');
		const catalog = (await (await send('tools/list')).json()).result.tools;
		expect(catalog.map((tool: Record<string, unknown>) => tool.name)).toEqual(
			version === CURRENT_PROTOCOL_VERSION
				? [
						'backend__echo',
					]
				: [
						'backend__echo',
						'backend__bad',
					],
		);
		const called = await send('tools/call', {
			name: 'backend__bad',
			arguments: {
				value: 1.5,
			},
		});
		if (version === CURRENT_PROTOCOL_VERSION) {
			expect((await called.json()).error.code).toBe(-32602);
			expect(invoke).not.toHaveBeenCalled();
		} else {
			expect(called.status).toBe(200);
			expect(invoke).toHaveBeenCalledTimes(1);
		}
	});

test('POST checks Origin and Accept before reading the body', async () => {
	const { route } = fixture();
	const post = (headers: Record<string, string>) =>
		route.POST(
			new Request('http://localhost:4567/mcp', {
				method: 'POST',
				headers: {
					Host: 'localhost:4567',
					'MCP-Protocol-Version': '2025-11-25',
					...headers,
				},
				body: '{}',
			}),
		);
	const accept = {
		Accept: 'application/json, text/event-stream',
	};
	expect(
		(
			await post({
				...accept,
				Origin: 'http://evil.example',
			})
		).status,
	).toBe(403);
	for (const value of [
		'application/json',
		'text/event-stream',
	])
		expect(
			(
				await post({
					Accept: value,
				})
			).status,
		).toBe(400);
	// Local origins and */* pass both checks; the empty body then fails.
	const passed = await post({
		Accept: '*/*',
		Origin: 'http://127.0.0.1:3000',
	});
	expect(passed.status).toBe(400);
	expect((await passed.json()).error.code).toBe(-32600);
});

test('gateway transport errors keep their HTTP status and use Invalid Request', async () => {
	const { route } = fixture();
	const post = (
		headers: Record<string, string>,
		method = 'tools/list',
		params: Record<string, unknown> = {},
	) =>
		route.POST(
			mcpPost({
				headers: {
					'MCP-Protocol-Version': '2025-11-25',
					...headers,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method,
					params,
				}),
			}),
		);
	const initialize = (headers: Record<string, string> = {}) =>
		post(headers, 'initialize', {
			protocolVersion: '2025-11-25',
			clientInfo: {
				name: 'codes',
				version: '1',
			},
		});
	const session = (await initialize()).headers.get('Mcp-Session-Id') ?? '';
	const cases: [
		Promise<Response>,
		number,
	][] = [
		[
			post({
				Origin: 'http://evil.example',
			}),
			403,
		],
		[
			post({
				Accept: 'application/json',
			}),
			400,
		],
		[
			post({}),
			400,
		],
		[
			post({
				'Mcp-Session-Id': 'unknown',
			}),
			404,
		],
		[
			post({
				'Mcp-Session-Id': session,
				'MCP-Protocol-Version': '2025-06-18',
			}),
			400,
		],
		[
			post({
				'Mcp-Session-Id': session,
				'MCP-Protocol-Version': '2024-11-05',
			}),
			400,
		],
		[
			initialize({
				'Mcp-Session-Id': session,
			}),
			400,
		],
	];
	for (const [response, status] of cases) {
		const resolved = await response;
		expect(resolved.status).toBe(status);
		expect((await resolved.json()).error.code).toBe(-32600);
	}
});
