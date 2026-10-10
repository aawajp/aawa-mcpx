import packageJson from '../../package.json' with { type: 'json' };

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
const GATEWAY_INFO = {
	name: packageJson.name,
	version: packageJson.version,
};
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
	return `=?base64?${btoa(Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''))}?=`;
};

const decodeHeaderValue = (value: string): string => {
	if (!/^[\t\x20-\x7e]*$/.test(value) || value.trim() !== value)
		throw new Error('Invalid header value');
	if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
	const encoded = value.slice(9, -2);
	// atob accepts malformed padding and whitespace; the protocol requires Base64.
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			encoded,
		)
	)
		throw new Error('Invalid Base64 header value');
	const decoded = atob(encoded);
	if (btoa(decoded) !== encoded) throw new Error('Invalid Base64 header value');
	return new TextDecoder('utf-8', {
		fatal: true,
		ignoreBOM: true,
	}).decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
};

type HeaderParameter = {
	name: string;
	path: string[];
	type: string;
};
const toolHeaderParameters = (schema: unknown): HeaderParameter[] => {
	const object = recordOf(schema);
	if (!object) return [];
	const cached = headerRules.get(object);
	if (cached instanceof Error) throw cached;
	if (cached) return cached;
	try {
		const parameters = compileToolHeaderParameters(object);
		headerRules.set(object, parameters);
		return parameters;
	} catch (error) {
		const issue =
			error instanceof Error
				? error
				: new Error('Invalid x-mcp-header annotation');
		headerRules.set(object, issue);
		throw issue;
	}
};

// Catalog fetch compiles these rules, including failures. Schema identity survives
// namespacing; both HTTP hops reuse them until a refresh replaces the schema object.
const headerRules = new WeakMap<object, HeaderParameter[] | Error>();
const schemaMaps = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
	'dependencies',
]);
const schemaBranches = new Set([
	'items',
	'prefixItems',
	'additionalItems',
	'contains',
	'unevaluatedItems',
	'additionalProperties',
	'unevaluatedProperties',
	'propertyNames',
	'allOf',
	'anyOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
	'contentSchema',
]);
const compileToolHeaderParameters = (schema: unknown): HeaderParameter[] => {
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
				typeof record.type !== 'string' ||
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
			// Traverse schema-valued keywords only. Examples/defaults/const values
			// are instance data; a literal x-mcp-header key there is no annotation.
			if (schemaMaps.has(key)) {
				for (const definition of Object.values(recordOf(child) ?? {}))
					visit(definition, path, false);
				continue;
			}
			if (schemaBranches.has(key)) visit(child, path, false);
		}
	};
	visit(schema, [], true);
	return parameters;
};

const validateToolHeaders = (
	headers: Headers,
	args: unknown,
	parameters: HeaderParameter[],
): string | undefined => {
	for (const parameter of parameters) {
		const headerName = `Mcp-Param-${parameter.name}`;
		const header = headers.get(headerName);
		let value: unknown = args;
		for (const key of parameter.path) value = recordOf(value)?.[key];
		if (value === undefined || value === null) {
			if (header !== null) return `Unexpected ${headerName}`;
			continue;
		}
		if (header === null) return `Missing ${headerName}`;
		const decoded = decodeHeaderValue(header);
		if (parameter.type === 'integer') {
			// MCP recommends numeric comparison (42.0 equals 42), while requiring
			// safe integers. Reject non-decimal spellings and non-finite values.
			if (
				!Number.isSafeInteger(value) ||
				!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(decoded) ||
				!Number.isSafeInteger(Number(decoded)) ||
				Number(decoded) !== value
			)
				return `Mismatched ${headerName}`;
			continue;
		}
		if (typeof value !== parameter.type || decoded !== String(value))
			return `Mismatched ${headerName}`;
	}
	return undefined;
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
	GATEWAY_INFO,
	isProtocolVersion,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	recordOf,
	requiresInitialization,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
	toolHeaderParameters,
	validateToolHeaders,
};
