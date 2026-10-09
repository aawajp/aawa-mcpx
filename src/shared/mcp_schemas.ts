import { type } from 'arktype';

// ArkType's Record accepts arrays as objects; MCP object fields do not.
const jsonObjectType = type('Record<string, unknown>').narrow(
	(value) => !Array.isArray(value),
);

// All supported revisions use integer IDs/codes and mutually exclusive results
// and errors. Error IDs may be absent for transport-level notification failures;
// the upstream client separately requires an exact ID match for a pending call.
const jsonRpcResponseType = type({
	jsonrpc: "'2.0'",
	id: 'string | number.integer',
	'method?': 'never',
	'params?': 'never',
	result: jsonObjectType,
	'error?': 'never',
	'[string]': 'unknown',
}).or({
	jsonrpc: "'2.0'",
	'id?': 'string | number.integer',
	'method?': 'never',
	'params?': 'never',
	'result?': 'never',
	error: {
		code: 'number.integer',
		message: 'string',
		'data?': 'unknown',
		'[string]': 'unknown',
	},
	'[string]': 'unknown',
});

const toolType = type({
	name: 'string',
	'description?': 'string',
	inputSchema: 'unknown',
	'outputSchema?': 'unknown',
	'[string]': 'unknown',
});

const promptArgumentType = type({
	name: 'string',
	'description?': 'string',
	'required?': 'boolean',
	'[string]': 'unknown',
});

const promptType = type({
	name: 'string',
	'description?': 'string',
	'arguments?': promptArgumentType.array(),
	'[string]': 'unknown',
});

const resourceType = type({
	uri: 'string',
	'name?': 'string',
	'description?': 'string',
	'mimeType?': 'string',
	'[string]': 'unknown',
});

const listToolsResultType = type({
	tools: toolType.array(),
	'nextCursor?': 'string',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const listPromptsResultType = type({
	prompts: promptType.array(),
	'nextCursor?': 'string',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const listResourcesResultType = type({
	resources: resourceType.array(),
	'nextCursor?': 'string',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const annotationsType = type({
	'audience?': "('user' | 'assistant')[]",
	'priority?': '0 <= number <= 1',
	'lastModified?': 'string',
	'[string]': 'unknown',
}).and(jsonObjectType);

const contentMetadata = {
	'annotations?': annotationsType,
	'_meta?': jsonObjectType,
	'[string]': 'unknown',
} as const;

const resourceContentsType = type({
	uri: 'string.url',
	'mimeType?': 'string',
	text: 'string',
	...contentMetadata,
}).or({
	uri: 'string.url',
	'mimeType?': 'string',
	blob: 'string.base64',
	...contentMetadata,
});

// The five content variants are shared by 2025-06-18, 2025-11-25, and
// 2026-07-28. Preserve extension fields and metadata instead of stripping them.
const toolContentType = type({
	type: "'text'",
	text: 'string',
	...contentMetadata,
})
	.or({
		type: "'image' | 'audio'",
		data: 'string.base64',
		mimeType: 'string',
		...contentMetadata,
	})
	.or({
		type: "'resource_link'",
		uri: 'string.url',
		name: 'string',
		'title?': 'string',
		'description?': 'string',
		'mimeType?': 'string',
		'size?': 'number',
		'icons?': type({
			src: 'string.url',
			'mimeType?': 'string',
			'sizes?': 'string[]',
			'theme?': "'light' | 'dark'",
			'[string]': 'unknown',
		}).array(),
		...contentMetadata,
	})
	.or({
		type: "'resource'",
		resource: resourceContentsType,
		...contentMetadata,
	});

const callToolResultType = type({
	content: toolContentType.array(),
	'isError?': 'boolean',
	'structuredContent?': 'unknown',
	'_meta?': jsonObjectType,
	'[string]': 'unknown',
});

const getPromptResultType = type({
	messages: 'unknown[]',
	'description?': 'string',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const readResourceResultType = type({
	contents: 'unknown[]',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

const pingResultType = type({
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
});

export {
	callToolResultType,
	getPromptResultType,
	jsonRpcResponseType,
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
	pingResultType,
	promptType,
	readResourceResultType,
	resourceType,
	toolType,
};
