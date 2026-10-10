import { logger } from '@/server/logger';
import { createToolResultNormalizer } from '@/server/mcp_upstreams/tool_result';
import type { ToolCallResult } from '@/shared/mcp_results';

import { expect, spyOn, test } from 'bun:test';

const context = {
	backend: 'provider',
	tool: 'search',
	protocolVersion: '2026-07-28',
};
const objectSchema = {
	type: 'object',
	properties: {
		count: {
			type: 'integer',
		},
	},
	required: ['count'],
};

test('schema mismatch logs a warning with tool context and returns normal data', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		const result: ToolCallResult = {
			content: [
				{
					type: 'text',
					text: 'Provider warning',
				},
			],
			structuredContent: {
				count: 'secret-provider-value',
			},
			_meta: {
				trace: 'kept',
			},
		};
		expect(createToolResultNormalizer()(result, objectSchema, context)).toEqual(
			result,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = JSON.parse(warn.mock.calls[0]?.[0] ?? '{}');
		expect(message.context).toEqual({
			...context,
			reason: 'schema_mismatch',
		});
		expect(message.error).toContain('/count');
		expect(warn.mock.calls[0]?.[0]).not.toContain('secret-provider-value');
	} finally {
		warn.mockRestore();
	}
});

for (const structuredContent of [
	{
		count: 2,
	},
	null,
	false,
	0,
	[1, 2],
	'hello',
])
	test(`recovers missing structured content from JSON ${JSON.stringify(structuredContent)}`, () => {
		const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
		try {
			const original: ToolCallResult = {
				content: [
					{
						type: 'text',
						text: JSON.stringify(structuredContent),
					},
					{
						type: 'text',
						text: 'Additional explanation',
					},
				],
			};
			const normalized = createToolResultNormalizer()(original, {}, context);
			expect(normalized).toEqual({
				content: [
					{
						type: 'text',
						text: 'Additional explanation',
					},
				],
				structuredContent,
			});
			expect(original.content).toHaveLength(2);
			expect(
				warn.mock.calls.map((call) => JSON.parse(call[0]).context.reason),
			).toEqual(['structured_content_recovered']);
		} finally {
			warn.mockRestore();
		}
	});

test('recovers a unique JSON candidate even if it mismatches the provider schema', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		const result: ToolCallResult = {
			content: [
				{
					type: 'text',
					text: '{"count":"wrong-type"}',
				},
			],
		};
		expect(createToolResultNormalizer()(result, objectSchema, context)).toEqual(
			{
				content: [],
				structuredContent: {
					count: 'wrong-type',
				},
			},
		);
		expect(
			warn.mock.calls.map((call) => JSON.parse(call[0]).context.reason),
		).toEqual(['structured_content_recovered', 'schema_mismatch']);
	} finally {
		warn.mockRestore();
	}
});

test('uses schema to select one candidate and preserves other JSON content', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		const unrelated = {
			type: 'text' as const,
			text: '{"notes":"keep me"}',
		};
		expect(
			createToolResultNormalizer()(
				{
					content: [
						unrelated,
						{
							type: 'text',
							text: '{"count":2}',
						},
					],
				},
				objectSchema,
				context,
			),
		).toEqual({
			content: [unrelated],
			structuredContent: {
				count: 2,
			},
		});
	} finally {
		warn.mockRestore();
	}
});

test('array item recovery preserves item order and duplicates', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		const content: ToolCallResult['content'] = [2, 1, 2].map((value) => ({
			type: 'text',
			text: String(value),
		}));
		expect(
			createToolResultNormalizer()(
				{
					content,
				},
				{
					type: 'array',
					items: {
						type: 'integer',
					},
				},
				context,
			),
		).toEqual({
			content,
			structuredContent: [2, 1, 2],
		});
		expect(
			createToolResultNormalizer()(
				{
					content: [
						{
							type: 'text',
							text: '2',
						},
						{
							type: 'text',
							text: '2',
						},
					],
				},
				{
					type: 'array',
					items: {
						type: 'integer',
					},
				},
				context,
			).structuredContent,
		).toEqual([2, 2]);
	} finally {
		warn.mockRestore();
	}
});

test('preserves ambiguous or non-JSON content and reports missing structured output', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		for (const texts of [
			['plain text'],
			['{"count":1}', '{"count":2}'],
			['{"count":'],
		]) {
			const original: ToolCallResult = {
				content: texts.map((text) => ({
					type: 'text',
					text,
				})),
			};
			expect(
				createToolResultNormalizer()(original, objectSchema, context),
			).toBe(original);
		}
		expect(
			warn.mock.calls.map((call) => JSON.parse(call[0]).context.reason),
		).toEqual([
			'missing_structured_content',
			'missing_structured_content',
			'missing_structured_content',
		]);
	} finally {
		warn.mockRestore();
	}
});

test('malformed schemas and unresolved references warn without rejecting responses', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		for (const schema of [
			{
				type: 'invalid',
			},
			{
				$ref: 'https://example.invalid/schema',
			},
			{
				$schema: 'https://example.invalid/dialect',
			},
		]) {
			const original: ToolCallResult = {
				content: [],
				structuredContent: {
					count: 2,
				},
			};
			expect(createToolResultNormalizer()(original, schema, context)).toEqual(
				original,
			);
		}
		expect(warn).toHaveBeenCalledTimes(3);
	} finally {
		warn.mockRestore();
	}
});

test('error results skip the success schema and content-only tools remain supported', () => {
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	try {
		const normalize = createToolResultNormalizer();
		const failure: ToolCallResult = {
			content: [
				{
					type: 'text',
					text: 'Tool failed',
				},
			],
			isError: true,
		};
		expect(normalize(failure, objectSchema, context)).toBe(failure);
		const normal: ToolCallResult = {
			content: [
				{
					type: 'text',
					text: 'Normal prose',
				},
			],
		};
		expect(normalize(normal, undefined, context)).toBe(normal);
		// Without an output schema, JSON-looking text is just text.
		for (const text of ['{"count":2}', '42']) {
			const plain: ToolCallResult = {
				content: [
					{
						type: 'text',
						text,
					},
				],
			};
			expect(normalize(plain, undefined, context)).toEqual(plain);
		}
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});
