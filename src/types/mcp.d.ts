declare module '@modelcontextprotocol/sdk/types.js' {
	export type Tool = import('@modelcontextprotocol/sdk/dist/esm/types.js').Tool;
	export type Prompt =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').Prompt;
	export type Resource =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').Resource;
	export type ListToolsResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').ListToolsResult;
	export type CallToolResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResult;
	export const CallToolResultSchema: typeof import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResultSchema;
	export type ListPromptsResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').ListPromptsResult;
	export type GetPromptResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').GetPromptResult;
	export type ListResourcesResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').ListResourcesResult;
	export type ReadResourceResult =
		import('@modelcontextprotocol/sdk/dist/esm/types.js').ReadResourceResult;
	export const SUPPORTED_PROTOCOL_VERSIONS: typeof import('@modelcontextprotocol/sdk/dist/esm/types.js').SUPPORTED_PROTOCOL_VERSIONS;
}

declare module '@modelcontextprotocol/sdk/client' {
	export { Client } from '@modelcontextprotocol/sdk/dist/esm/client/index.js';
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
	export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
}
