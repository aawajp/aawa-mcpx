import type { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { stripDuplicateToolContent } from '@/server/mcp_upstreams/tool_result';

import { expect, test } from 'bun:test';

test('removes duplicate JSON while preserving independent content and metadata', () => {
	const structuredContent = {
		count: 2,
		items: [
			{
				name: 'alpha',
				active: true,
			},
		],
	};
	const retained: CallToolResult['content'] = [
		{
			type: 'text',
			text: 'Two items found.',
		},
		{
			type: 'text',
			text: '{"count":3,"items":[{"name":"alpha","active":true}]}',
		},
		{
			type: 'text',
			text: '{"count":2}',
		},
		{
			type: 'text',
			text: JSON.stringify({
				...structuredContent,
				extra: 'independent data',
			}),
		},
		{
			type: 'text',
			text: '{not valid JSON}',
		},
		{
			type: 'image',
			data: 'aW1hZ2U=',
			mimeType: 'image/png',
		},
		{
			type: 'audio',
			data: 'YXVkaW8=',
			mimeType: 'audio/wav',
		},
		{
			type: 'resource_link',
			name: 'report',
			uri: 'file:///report',
		},
		{
			type: 'resource',
			resource: {
				uri: 'file:///notes',
				text: 'Notes',
			},
		},
	];
	const original: CallToolResult = {
		content: [
			{
				type: 'text',
				text: JSON.stringify(structuredContent),
			},
			...retained,
			{
				type: 'text',
				text: ' { "items": [{ "active": true, "name": "alpha" }], "count": 2 } ',
			},
		],
		structuredContent,
		isError: true,
		_meta: {
			trace: 'test',
		},
		resultType: 'complete',
	};
	const result = stripDuplicateToolContent(original);
	expect(result).toEqual({
		...original,
		content: retained,
	});
	expect(original.content).toHaveLength(retained.length + 2);
	expect(result.structuredContent).toBe(structuredContent);
});

for (const structuredContent of [
	{
		count: 2,
	},
	[
		1,
		{
			name: 'alpha',
		},
	],
	'hello',
	0,
	false,
	null,
])
	test(`retains an empty content array for duplicate ${JSON.stringify(structuredContent)}`, () => {
		const result = stripDuplicateToolContent({
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(structuredContent),
				},
			],
			structuredContent,
		});
		expect(result).toEqual({
			content: [],
			structuredContent,
		});
	});

test('retains text and JSON when structured content is absent', () => {
	const result: CallToolResult = {
		content: [
			{
				type: 'text',
				text: '{"count":2}',
			},
			{
				type: 'text',
				text: 'hello',
			},
		],
	};
	expect(stripDuplicateToolContent(result)).toBe(result);
});

test('does not coerce types or reorder arrays when comparing JSON', () => {
	const content: CallToolResult['content'] = [
		{
			type: 'text',
			text: '{"values":[2,1],"count":2}',
		},
		{
			type: 'text',
			text: '{"values":[1,2],"count":"2"}',
		},
	];
	expect(
		stripDuplicateToolContent({
			content,
			structuredContent: {
				values: [
					1,
					2,
				],
				count: 2,
			},
		}).content,
	).toEqual(content);
});
