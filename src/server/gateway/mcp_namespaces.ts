import type {
	Prompt,
	Resource,
	ResourceTemplate,
	Tool,
} from '@modelcontextprotocol/sdk/types';

import {
	addPrefix,
	addResourcePrefix,
	addResourceTemplatePrefix,
} from '@/shared/mcp_namespaces';

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

// Descriptions start with the backend that owns the item.
const describe = (serverName: string, description?: string): string =>
	description ? `[${serverName}] ${description}` : `[${serverName}]`;

const namespaceTool = (params: NamespaceToolParams): Tool => {
	const { serverName, tool } = params;

	return {
		...tool,
		name: addPrefix({
			serverName,
			name: tool.name,
		}),
		description: describe(serverName, tool.description),
	};
};

const namespacePrompt = (params: NamespacePromptParams): Prompt => {
	const { serverName, prompt } = params;

	return {
		...prompt,
		name: addPrefix({
			serverName,
			name: prompt.name,
		}),
		description: describe(serverName, prompt.description),
	};
};

const namespaceResource = (params: NamespaceResourceParams): Resource => {
	const { serverName, resource } = params;

	return {
		...resource,
		uri: addResourcePrefix({
			serverName,
			uri: resource.uri,
		}),
		description: describe(serverName, resource.description),
	};
};

const namespaceResourceTemplate = (params: {
	serverName: string;
	resourceTemplate: ResourceTemplate;
}): ResourceTemplate => {
	const { serverName, resourceTemplate } = params;

	return {
		...resourceTemplate,
		uriTemplate: addResourceTemplatePrefix({
			serverName,
			uriTemplate: resourceTemplate.uriTemplate,
		}),
		description: describe(serverName, resourceTemplate.description),
	};
};

export {
	namespacePrompt,
	namespaceResource,
	namespaceResourceTemplate,
	namespaceTool,
};
