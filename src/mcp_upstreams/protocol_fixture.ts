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
		case 'tools/call':
			result = {
				content: [
					{
						type: 'text',
						text: String(recordOf(params.arguments)?.text ?? ''),
					},
				],
			};
			break;
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

if (import.meta.main) {
	const version = process.argv[2] ?? '2025-11-25';
	let buffer = '';
	for await (const chunk of Bun.stdin.stream()) {
		buffer += new TextDecoder().decode(chunk);
		let end = buffer.indexOf('\n');
		while (end >= 0) {
			const message = recordOf(JSON.parse(buffer.slice(0, end)));
			buffer = buffer.slice(end + 1);
			if (message && 'id' in message)
				console.log(JSON.stringify(fixtureReply(message, version)));
			end = buffer.indexOf('\n');
		}
	}
}

export { fixtureReply };
