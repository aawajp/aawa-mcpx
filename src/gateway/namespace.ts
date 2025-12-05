import type {
	Prompt,
	Resource,
	Tool,
} from '@modelcontextprotocol/sdk/types.js';

type AddPrefixParams = {
	serverName: string;
	name: string;
};

type ParsePrefixResult = {
	serverName: string;
	originalName: string;
};

type NamespaceToolParams = {
	serverName: string;
	tool: Tool;
};

type NamespacePromptParams = {
	serverName: string;
	prompt: Prompt;
};

type NamespaceResourceParams = {
	serverName: string;
	resource: Resource;
};

type ParseResourceUriResult = {
	serverName: string;
	originalUri: string;
};

const TOOL_SEPARATOR = '__';
const RESOURCE_SEPARATOR = '://';

const addPrefix = (params: AddPrefixParams): string => {
	const { serverName, name } = params;
	return `${serverName}${TOOL_SEPARATOR}${name}`;
};

const parsePrefix = (prefixedName: string): ParsePrefixResult => {
	const [serverName, ...rest] = prefixedName.split(TOOL_SEPARATOR);
	const originalName = rest.join(TOOL_SEPARATOR);

	if (!serverName || !originalName) {
		throw new Error(`Invalid prefixed name "${prefixedName}"`);
	}

	return { serverName, originalName };
};

const namespaceTool = (params: NamespaceToolParams): Tool => {
	const { serverName, tool } = params;

	return {
		...tool,
		name: addPrefix({ serverName, name: tool.name }),
		description: tool.description
			? `[${serverName}] ${tool.description}`
			: `[${serverName}]`,
	};
};

const namespacePrompt = (params: NamespacePromptParams): Prompt => {
	const { serverName, prompt } = params;

	return {
		...prompt,
		name: addPrefix({ serverName, name: prompt.name }),
		description: prompt.description
			? `[${serverName}] ${prompt.description}`
			: `[${serverName}]`,
	};
};

const namespaceResource = (params: NamespaceResourceParams): Resource => {
	const { serverName, resource } = params;
	const description = resource.description
		? `[${serverName}] ${resource.description}`
		: `[${serverName}]`;

	return {
		...resource,
		uri: `${serverName}${RESOURCE_SEPARATOR}${resource.uri}`,
		description,
	};
};

const parseResourceUri = (uri: string): ParseResourceUriResult => {
	const [serverName, ...rest] = uri.split(RESOURCE_SEPARATOR);
	const originalUri = rest.join(RESOURCE_SEPARATOR);

	if (!serverName || !originalUri) {
		throw new Error(`Invalid resource URI "${uri}"`);
	}

	return { serverName, originalUri };
};

export {
	addPrefix,
	parsePrefix,
	namespaceTool,
	namespacePrompt,
	namespaceResource,
	parseResourceUri,
	type ParsePrefixResult,
	type ParseResourceUriResult,
};
