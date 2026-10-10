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

const namespaceTool = (params: NamespaceToolParams): Tool => {
	const { serverName, tool } = params;

	return {
		...tool,
		name: addPrefix({
			serverName,
			name: tool.name,
		}),
		description: tool.description
			? `[${serverName}] ${tool.description}`
			: `[${serverName}]`,
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
		uri: addResourcePrefix({
			serverName,
			uri: resource.uri,
		}),
		description,
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
		description: resourceTemplate.description
			? `[${serverName}] ${resourceTemplate.description}`
			: `[${serverName}]`,
	};
};

export {
	namespacePrompt,
	namespaceResource,
	namespaceResourceTemplate,
	namespaceTool,
};
