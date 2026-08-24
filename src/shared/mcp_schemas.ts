import { type } from 'arktype';

const toolType = type({
	name: 'string',
	'description?': 'string',
	inputSchema: 'unknown',
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

const callToolResultType = type({
	content: 'unknown[]',
	'isError?': 'boolean',
	'structuredContent?': 'Record<string, unknown>',
	'_meta?': 'Record<string, unknown>',
	'[string]': 'unknown',
}).or({
	toolResult: 'unknown',
	'_meta?': 'Record<string, unknown>',
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
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
	pingResultType,
	promptType,
	readResourceResultType,
	resourceType,
	toolType,
};
