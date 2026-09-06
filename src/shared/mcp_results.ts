import type { CallToolResult } from '@modelcontextprotocol/sdk/types';

const toolErrorResult = (text: string): CallToolResult => ({
	content: [
		{
			type: 'text',
			text,
		},
	],
	isError: true,
});

export { toolErrorResult };
