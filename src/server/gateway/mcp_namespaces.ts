import type {
	Prompt,
	Resource,
	ResourceTemplateType,
	Tool,
} from '@modelcontextprotocol/client';

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

// Descriptions start with the backend that owns the item. Titles are the
// public name, so clients that show titles keep items grouped by backend.
const describe = (serverName: string, description?: string): string =>
	description ? `[${serverName}] ${description}` : `[${serverName}]`;

const namespaceTool = (params: NamespaceToolParams): Tool => {
	const { serverName, tool } = params;
	const name = addPrefix({
		serverName,
		name: tool.name,
	});

	return {
		...tool,
		name,
		title: name,
		...(tool.annotations
			? {
					annotations: {
						...tool.annotations,
						title: name,
					},
				}
			: {}),
		description: describe(serverName, tool.description),
	};
};

const namespacePrompt = (params: NamespacePromptParams): Prompt => {
	const { serverName, prompt } = params;
	const name = addPrefix({
		serverName,
		name: prompt.name,
	});

	return {
		...prompt,
		name,
		title: name,
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
	resourceTemplate: ResourceTemplateType;
}): ResourceTemplateType => {
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
