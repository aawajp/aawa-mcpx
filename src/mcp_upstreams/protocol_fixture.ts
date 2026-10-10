import {
	CACHEABLE_METHODS,
	CURRENT_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META,
	recordOf,
} from '@/shared/mcp_protocol';

const fixtureReply = (
	message: Record<string, unknown>,
	version: string,
): Record<string, unknown> => {
	const params = recordOf(message.params) ?? {};
	const usesRequestMetadata = version === CURRENT_PROTOCOL_VERSION;
	const error = (code: number, text: string): Record<string, unknown> => ({
		jsonrpc: '2.0',
		id: message.id,
		error: {
			code,
			message: text,
		},
	});
	if (message.method === 'server/discover' && !usesRequestMetadata)
		return error(-32600, 'Initialize first');
	if (
		usesRequestMetadata &&
		recordOf(params._meta)?.[PROTOCOL_VERSION_META] !== version
	)
		return error(-32022, 'Incorrect version');
	let result: Record<string, unknown>;
	switch (message.method) {
		case 'server/discover':
			result = {
				supportedVersions: [
					version,
				],
				capabilities: {
					tools: {},
					prompts: {},
					resources: {},
				},
			};
			break;
		case 'initialize':
			result = {
				protocolVersion: version,
				serverInfo: {
					name: 'fixture',
					version: '1',
				},
				capabilities: {
					tools: {},
					prompts: {},
					resources: {},
				},
			};
			break;
		case 'tools/list':
			result = {
				tools: [
					{
						name: 'echo',
						inputSchema: {
							type: 'object',
							properties: {
								text: {
									type: 'string',
									'x-mcp-header': 'Text',
								},
							},
						},
					},
				],
			};
			break;
		case 'tools/call': {
			const args = recordOf(params.arguments) ?? {};
			// Test-only modes let the integration tests exercise the wire validator
			// over stdio without bypassing ProtocolClient's response parsing.
			if (args.fixtureMode === 'envelope') {
				const reply: Record<string, unknown> = {
					jsonrpc: '2.0',
					id: message.id,
					...recordOf(args.reply),
				};
				if (args.omitId) delete reply.id;
				return reply;
			}
			if (args.fixtureMode === 'result') {
				result = recordOf(args.reply) ?? {};
				break;
			}
			result = {
				content: [
					{
						type: 'text',
						text: String(args.text ?? ''),
					},
				],
				...('structured' in args
					? {
							structuredContent: args.structured,
						}
					: {}),
			};
			break;
		}
		case 'prompts/list':
			result = {
				prompts: [
					{
						name: 'greet',
					},
				],
			};
			break;
		case 'prompts/get':
			result = {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: 'hello',
						},
					},
				],
			};
			break;
		case 'resources/list':
			result = {
				resources: [
					{
						name: 'example',
						uri: 'file:///example',
					},
				],
			};
			break;
		case 'resources/read':
			result = {
				contents: [
					{
						uri: params.uri,
						text: 'hello',
					},
				],
			};
			break;
		case 'ping':
			if (usesRequestMetadata)
				return error(-32601, 'MCP 2026-07-28 does not define ping');
			result = {};
			break;
		default:
			return error(-32601, 'Method not found');
	}
	return {
		jsonrpc: '2.0',
		id: message.id,
		result: {
			...result,
			...(usesRequestMetadata
				? {
						resultType: 'complete',
						...(CACHEABLE_METHODS.has(String(message.method))
							? {
									ttlMs: 0,
									cacheScope: 'private',
								}
							: {}),
					}
				: {}),
		},
	};
};

type FixtureOptions = {
	// Serve tools from this JSON file with an hour-long cache TTL.
	catalogPath?: string;
	// Return each request's params in the result's _meta.
	echoRequest?: boolean;
};

type FixtureHttpHandler = (
	message: Record<string, unknown>,
	reply: Record<string, unknown> | undefined,
	request: Request,
) => Response | undefined | Promise<Response | undefined>;

type FixtureBackend = {
	config:
		| {
				type: 'stdio';
				command: string;
				args: string[];
		  }
		| {
				type: 'http';
				url: string;
		  };
	stop: () => void;
};

const optionReply = async (
	message: Record<string, unknown>,
	version: string,
	options: FixtureOptions,
): Promise<Record<string, unknown>> => {
	const reply = fixtureReply(message, version);
	const result = recordOf(reply.result);
	if (result && options.echoRequest)
		result._meta = {
			'com.example/request': message.params,
		};
	if (result && options.catalogPath) {
		if (message.method === 'tools/list')
			result.tools = await Bun.file(options.catalogPath).json();
		if ('ttlMs' in result) result.ttlMs = 3_600_000;
	}
	return reply;
};

// Starts the same fixture over either transport. Over HTTP, `handle` sees every
// message with its reply (undefined for notifications); it may change the reply
// in place or return its own response.
const startFixtureBackend = (
	transport: 'http' | 'stdio',
	version: string,
	options: FixtureOptions & {
		cancellation?: boolean;
		handle?: FixtureHttpHandler;
	} = {},
): FixtureBackend => {
	if (transport === 'stdio') {
		const mode =
			options.catalogPath ??
			(options.echoRequest
				? '--echo-request'
				: options.cancellation
					? '--cancellation'
					: undefined);
		return {
			config: {
				type: 'stdio',
				command: process.execPath,
				args: [
					import.meta.path,
					version,
					...(mode
						? [
								mode,
							]
						: []),
				],
			},
			stop: () => undefined,
		};
	}
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const message = recordOf(await request.json()) ?? {};
			const reply =
				'id' in message
					? await optionReply(message, version, options)
					: undefined;
			return (
				(await options.handle?.(message, reply, request)) ??
				(reply
					? Response.json(reply)
					: new Response(null, {
							status: 202,
						}))
			);
		},
	});
	return {
		config: {
			type: 'http',
			url: server.url.href,
		},
		stop: () => server.stop(true),
	};
};

if (import.meta.main) {
	const version = process.argv[2] ?? '2025-11-25';
	const mode = process.argv[3];
	const cancellationMode = mode === '--cancellation';
	const options: FixtureOptions = {
		echoRequest: mode === '--echo-request',
		catalogPath: mode && !mode.startsWith('--') ? mode : undefined,
	};
	const events: Record<string, unknown>[] = [];
	let buffer = '';
	for await (const chunk of Bun.stdin.stream()) {
		buffer += new TextDecoder().decode(chunk);
		let end = buffer.indexOf('\n');
		while (end >= 0) {
			const message = recordOf(JSON.parse(buffer.slice(0, end)));
			buffer = buffer.slice(end + 1);
			if (message && cancellationMode) events.push(message);
			if (message && 'id' in message) {
				const reply = await optionReply(message, version, options);
				const result = recordOf(reply.result);
				if (cancellationMode && result) {
					const mode = recordOf(
						recordOf(message.params)?.arguments,
					)?.fixtureMode;
					if (mode === 'events')
						result.structuredContent = {
							events,
						};
					if (
						mode === 'delayed' ||
						recordOf(message.params)?.fixtureDelay ||
						recordOf(recordOf(message.params)?._meta)?.['com.example/delayed']
					) {
						// Deliberately violate cancellation to exercise late-response handling.
						setTimeout(() => console.log(JSON.stringify(reply)), 100);
					} else console.log(JSON.stringify(reply));
				} else console.log(JSON.stringify(reply));
			}
			end = buffer.indexOf('\n');
		}
	}
}

export { fixtureReply, startFixtureBackend };
