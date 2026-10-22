import {
	namespacePrompt,
	namespaceTool,
} from '@/server/gateway/mcp_namespaces';

import { expect, test } from 'bun:test';

test('tools and prompts get their public name as title', () => {
	expect(
		namespaceTool({
			serverName: 'github',
			tool: {
				name: 'get_commit',
				title: 'Get commit',
				description: 'Get a commit',
				inputSchema: {
					type: 'object',
				},
				annotations: {
					title: 'Get commit details',
					readOnlyHint: true,
				},
			},
		}),
	).toEqual({
		name: 'github__get_commit',
		title: 'github__get_commit',
		description: '[github] Get a commit',
		inputSchema: {
			type: 'object',
		},
		annotations: {
			title: 'github__get_commit',
			readOnlyHint: true,
		},
	});
	expect(
		namespacePrompt({
			serverName: 'github',
			prompt: {
				name: 'summarize',
				title: 'Summarize',
			},
		}),
	).toEqual({
		name: 'github__summarize',
		title: 'github__summarize',
		description: '[github]',
	});
});
