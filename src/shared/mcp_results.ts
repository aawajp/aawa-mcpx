import type { CallToolResult } from '@modelcontextprotocol/sdk/types';

// The SDK's CallToolResult restricts structuredContent to a JSON object, matching
// MCP 2025-06-18 and 2025-11-25. MCP 2026-07-28 also permits arrays, primitives,
// and null, so the gateway needs a wider type before adapting results for clients.
// https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content
type ToolCallResult = {
	content: CallToolResult['content'];
	structuredContent?: unknown;
	isError?: boolean;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
};

const toolErrorResult = (text: string): ToolCallResult => ({
	content: [
		{
			type: 'text',
			text,
		},
	],
	isError: true,
});

export type { ToolCallResult };
export { toolErrorResult };
