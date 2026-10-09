type AddPrefixParams = {
	serverName: string;
	name: string;
};
type ParsePrefixResult = {
	serverName: string;
	originalName: string;
};
type ParseResourceUriResult = {
	serverName: string;
	originalUri: string;
};

const ESCAPE_PREFIX = 'mcpx-';
const RESOURCE_PREFIX = 'aawa-mcpx://resource/';

const encodeNamespace = (name: string): string => {
	// A trailing underscore overlaps the separator when an item starts with one.
	// Reserve the escape prefix too, so literal names cannot collide with escapes.
	if (
		/^[A-Za-z0-9_.-]+$/.test(name) &&
		!name.includes('__') &&
		!name.endsWith('_') &&
		name !== '.' &&
		name !== '..' &&
		!name.startsWith(ESCAPE_PREFIX)
	)
		return name;
	let encoded = ESCAPE_PREFIX;
	// Dot-only names are escaped too: URL consumers normalize those path segments.
	// Encode UTF-16 code units: this round-trips every JSON string in the browser
	// and server without Buffer, Unicode normalization, or replacement characters.
	for (let index = 0; index < name.length; index += 1)
		encoded += name.charCodeAt(index).toString(16).padStart(4, '0');
	return encoded;
};

const decodeNamespace = (encoded: string): string => {
	let name = encoded;
	if (encoded.startsWith(ESCAPE_PREFIX)) {
		const hex = encoded.slice(ESCAPE_PREFIX.length);
		if (!/^(?:[0-9a-f]{4})*$/.test(hex))
			throw new Error('Invalid namespace encoding');
		name = '';
		for (let index = 0; index < hex.length; index += 4)
			name += String.fromCharCode(
				Number.parseInt(hex.slice(index, index + 4), 16),
			);
	}
	// Reject aliases instead of allowing two public namespaces to route identically.
	if (encodeNamespace(name) !== encoded)
		throw new Error('Invalid namespace encoding');
	return name;
};

const addPrefix = (params: AddPrefixParams): string =>
	`${encodeNamespace(params.serverName)}__${params.name}`;

const parsePrefix = (name: string): ParsePrefixResult => {
	const separator = name.indexOf('__');
	if (separator <= 0 || separator + 2 === name.length)
		throw new Error(`Invalid prefixed name "${name}"`);
	return {
		serverName: decodeNamespace(name.slice(0, separator)),
		originalName: name.slice(separator + 2),
	};
};

const addResourcePrefix = (params: {
	serverName: string;
	uri: string;
}): string =>
	`${RESOURCE_PREFIX}${encodeNamespace(params.serverName)}/${encodeURIComponent(params.uri)}`;

const parseResourceUri = (uri: string): ParseResourceUriResult => {
	let serverName: string;
	let originalUri: string;
	if (uri.startsWith(RESOURCE_PREFIX)) {
		const path = uri.slice(RESOURCE_PREFIX.length);
		const separator = path.indexOf('/');
		if (separator <= 0) throw new Error(`Invalid resource URI "${uri}"`);
		serverName = decodeNamespace(path.slice(0, separator));
		originalUri = decodeURIComponent(path.slice(separator + 1));
		if (
			addResourcePrefix({
				serverName,
				uri: originalUri,
			}) !== uri
		)
			throw new Error(`Invalid resource URI "${uri}"`);
	} else {
		// Accept previously issued URIs only when the legacy scheme identifies a
		// backend unambiguously. Never interpret malformed new wrappers as legacy.
		const legacy = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.+)$/.exec(uri);
		if (!legacy?.[1] || !legacy[2] || legacy[1] === 'aawa-mcpx')
			throw new Error(`Invalid resource URI "${uri}"`);
		serverName = legacy[1];
		originalUri = legacy[2];
	}
	// Check the decoded absolute URI once at dispatch. Preserve its spelling:
	// URL serialization would normalize case, escapes, and path segments.
	if (
		!/^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/.test(
			originalUri,
		)
	)
		throw new Error(`Invalid resource URI "${uri}"`);
	return {
		serverName,
		originalUri,
	};
};

export {
	addPrefix,
	addResourcePrefix,
	type ParsePrefixResult,
	type ParseResourceUriResult,
	parsePrefix,
	parseResourceUri,
};
