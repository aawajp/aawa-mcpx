import {
	invalidToolResults,
	validToolContent,
} from '@/shared/mcp_schema_fixtures';
import { callToolResultType } from '@/shared/mcp_schemas';

import { expect, it } from 'bun:test';

it('validates every tool content type without stripping extensions or metadata', () => {
	const result = {
		content: validToolContent.map((block) => ({
			...block,
			annotations: {
				audience: ['assistant' as const],
				priority: 1,
			},
			_meta: {
				'com.example/trace': 'kept',
			},
			'com.example/extension': {
				kept: true,
			},
		})),
		_meta: {
			'com.example/trace': 'kept',
		},
		'com.example/extension': {
			kept: true,
		},
	};
	expect(callToolResultType.assert(result)).toEqual(result);
	for (const structuredContent of [{}, [], '', 0, false, null])
		expect(
			callToolResultType.allows({
				content: [],
				structuredContent,
			}),
		).toBe(true);
	expect(
		callToolResultType.allows({
			content: [],
			isError: true,
		}),
	).toBe(true);
});

it('rejects malformed tool content and unsupported content-free envelopes', () => {
	for (const result of invalidToolResults)
		expect(callToolResultType.allows(result)).toBe(false);
});
