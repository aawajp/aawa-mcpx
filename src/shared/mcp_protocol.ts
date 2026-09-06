const SUPPORTED_PROTOCOL_VERSIONS = [
	'2026-07-28',
	'2025-11-25',
	'2025-06-18',
] as const;
type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
const CURRENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const requiresInitialization = (version: string): boolean =>
	version === '2025-11-25' || version === '2025-06-18';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const CACHEABLE_METHODS = new Set([
	'server/discover',
	'tools/list',
	'prompts/list',
	'resources/list',
	'resources/templates/list',
	'resources/read',
]);

const isProtocolVersion = (value: unknown): value is ProtocolVersion =>
	SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === value);

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const encodeHeaderValue = (value: string): string => {
	// MCP 2026-07-28 requires UTF-8 Base64 for unsafe values and for literal
	// sentinel-shaped text, which would otherwise be mistaken for encoded data.
	if (
		/^[\t\x20-\x7e]*$/.test(value) &&
		value.trim() === value &&
		!(value.startsWith('=?base64?') && value.endsWith('?='))
	)
		return value;
	return `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
};

const decodeHeaderValue = (value: string): string => {
	if (!/^[\t\x20-\x7e]*$/.test(value)) throw new Error('Invalid header value');
	if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
	return new TextDecoder('utf-8', {
		fatal: true,
	}).decode(
		Uint8Array.from(atob(value.slice(9, -2)), (char) => char.charCodeAt(0)),
	);
};

type HeaderParameter = {
	name: string;
	path: string[];
	type: string;
};
const toolHeaderParameters = (schema: unknown): HeaderParameter[] => {
	const parameters: HeaderParameter[] = [];
	const names = new Set<string>();
	// Only a chain of schema `properties` keys is a valid header source in
	// 2026-07-28. Still visit other branches to reject annotations hidden there.
	const visit = (value: unknown, path: string[], reachable: boolean): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child, path, false);
			return;
		}
		const record = recordOf(value);
		if (!record) return;
		if ('x-mcp-header' in record) {
			const name = record['x-mcp-header'];
			if (
				!reachable ||
				path.length === 0 ||
				typeof name !== 'string' ||
				!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
				names.has(name.toLowerCase()) ||
				![
					'string',
					'integer',
					'boolean',
				].includes(String(record.type))
			)
				throw new Error('Invalid x-mcp-header annotation');
			names.add(name.toLowerCase());
			parameters.push({
				name,
				path,
				type: String(record.type),
			});
		}
		for (const [key, child] of Object.entries(record)) {
			if (key === 'properties' && reachable) {
				for (const [property, definition] of Object.entries(
					recordOf(child) ?? {},
				))
					visit(
						definition,
						[
							...path,
							property,
						],
						true,
					);
				continue;
			}
			visit(child, path, false);
		}
	};
	visit(schema, [], true);
	return parameters;
};

const protocolHeaders = (
	method: string,
	params: Record<string, unknown>,
	schema?: unknown,
): Headers => {
	const headers = new Headers({
		'MCP-Protocol-Version': CURRENT_PROTOCOL_VERSION,
		'Mcp-Method': method,
	});
	const name = method === 'resources/read' ? params.uri : params.name;
	if (
		[
			'tools/call',
			'prompts/get',
			'resources/read',
		].includes(method) &&
		typeof name === 'string'
	)
		headers.set('Mcp-Name', encodeHeaderValue(name));
	if (method !== 'tools/call') return headers;
	for (const parameter of toolHeaderParameters(schema)) {
		let value: unknown = params.arguments;
		for (const key of parameter.path) value = recordOf(value)?.[key];
		if (value === undefined || value === null) continue;
		if (
			parameter.type === 'integer'
				? !Number.isSafeInteger(value)
				: typeof value !== parameter.type
		)
			throw new Error('Invalid mirrored parameter type');
		headers.set(
			`Mcp-Param-${parameter.name}`,
			encodeHeaderValue(String(value)),
		);
	}
	return headers;
};

export type { ProtocolVersion };
export {
	CACHEABLE_METHODS,
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	decodeHeaderValue,
	encodeHeaderValue,
	isProtocolVersion,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	recordOf,
	requiresInitialization,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
	toolHeaderParameters,
};
