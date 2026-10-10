import type { callToolResultType } from '@/shared/mcp_schemas';

// These fixtures are also sent through real HTTP/SSE and stdio upstreams.
const validToolContent: typeof callToolResultType.infer.content = [
	{
		type: 'text',
		text: '',
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
		uri: 'urn:example:report',
		name: 'report',
		title: 'Report',
		size: 0,
		icons: [
			{
				src: 'data:image/png;base64,aW1hZ2U=',
				theme: 'dark',
			},
		],
	},
	{
		type: 'resource',
		resource: {
			uri: 'file:///notes',
			text: '',
			annotations: {
				audience: ['user'],
				priority: 0,
				lastModified: '2025-01-12T15:00:58Z',
			},
			_meta: {
				'com.example/source': 'fixture',
			},
		},
	},
	{
		type: 'resource',
		resource: {
			uri: 'custom:///data',
			blob: 'YmluYXJ5',
			mimeType: 'application/octet-stream',
		},
	},
];

const invalidToolResults: unknown[] = [
	{
		toolResult: {},
	},
	{
		structuredContent: {},
	},
	{
		content: null,
	},
	{
		content: {},
		structuredContent: {},
	},
	{
		content: [null],
	},
	{
		content: [1],
	},
	{
		content: [
			{
				type: 'unsupported',
			},
		],
	},
	{
		content: [
			{
				type: 'text',
			},
		],
	},
	{
		content: [
			{
				type: 'text',
				text: 3,
			},
		],
	},
	{
		content: [
			{
				type: 'image',
				data: 'aW1hZ2U=',
			},
		],
	},
	{
		content: [
			{
				type: 'image',
				data: 'not base64!',
				mimeType: 'image/png',
			},
		],
	},
	{
		content: [
			{
				type: 'audio',
				data: 3,
				mimeType: 'audio/wav',
			},
		],
	},
	{
		content: [
			{
				type: 'audio',
				data: 'a===',
				mimeType: 'audio/wav',
			},
		],
	},
	{
		content: [
			{
				type: 'resource_link',
				uri: 'file:///report',
			},
		],
	},
	{
		content: [
			{
				type: 'resource_link',
				uri: 'not a URI',
				name: 'report',
			},
		],
	},
	{
		content: [
			{
				type: 'resource_link',
				uri: 'file:///report',
				name: 'report',
				icons: [
					{
						src: 'https://example.com/icon.png',
						sizes: 1,
					},
				],
			},
		],
	},
	{
		content: [
			{
				type: 'resource',
				resource: null,
			},
		],
	},
	{
		content: [
			{
				type: 'resource',
				resource: {
					uri: 'file:///notes',
				},
			},
		],
	},
	{
		content: [
			{
				type: 'resource',
				resource: {
					uri: 'file:///notes',
					text: 1,
				},
			},
		],
	},
	{
		content: [
			{
				type: 'resource',
				resource: {
					uri: 'file:///notes',
					blob: 'not base64!',
				},
			},
		],
	},
	{
		content: [
			{
				type: 'text',
				text: 'hello',
				annotations: {
					priority: 2,
				},
			},
		],
	},
	{
		content: [
			{
				type: 'text',
				text: 'hello',
				annotations: {
					audience: ['system'],
				},
			},
		],
	},
	{
		content: [
			{
				type: 'text',
				text: 'hello',
				_meta: [],
			},
		],
	},
	{
		content: [],
		isError: 'true',
	},
	{
		content: [],
		_meta: [],
	},
];

export { invalidToolResults, validToolContent };
