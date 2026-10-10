import {
	decodeHeaderValue,
	encodeHeaderValue,
	protocolHeaders,
	toolHeaderParameters,
	validateToolHeaders,
} from '@/shared/mcp_protocol';

import { expect, test } from 'bun:test';

test('header values round-trip Unicode, whitespace, sentinels, BOM, and long strings', () => {
	for (const value of [
		'',
		'hello',
		'Hello, 世界',
		' padded ',
		'a\tb',
		'a\nb',
		'\ufefftext',
		'=?base64?literal?=',
		'世'.repeat(100000),
	])
		expect(decodeHeaderValue(encodeHeaderValue(value))).toBe(value);
	for (const value of [
		' raw ',
		'=?base64?YQ?=',
		'=?base64?YQ===?=',
		'=?base64?YR==?=',
		'=?base64?Y Q==?=',
		'=?base64?/w==?=',
		'bad\nvalue',
	])
		expect(() => decodeHeaderValue(value)).toThrow();
});

test('header rules compile once per schema object, including failures, and ignore instance data', () => {
	let reads = 0;
	const schema = {
		type: 'object',
		properties: {
			nested: {
				type: 'object',
				properties: {
					value: {
						type: 'string',
						get 'x-mcp-header'() {
							reads++;
							return 'Value';
						},
					},
				},
			},
		},
		default: {
			'x-mcp-header': 'literal instance data',
		},
	};
	const first = toolHeaderParameters(schema);
	expect(first).toEqual([
		{
			name: 'Value',
			path: [
				'nested',
				'value',
			],
			type: 'string',
		},
	]);
	const compiledReads = reads;
	for (let index = 0; index < 3; index++) {
		expect(toolHeaderParameters(schema)).toBe(first);
		expect(
			protocolHeaders(
				'tools/call',
				{
					name: 'echo',
					arguments: {
						nested: {
							value: 'works',
						},
					},
				},
				schema,
			).get('Mcp-Param-Value'),
		).toBe('works');
	}
	expect(reads).toBe(compiledReads);
	let badReads = 0;
	const invalid = {
		properties: {
			value: {
				type: 'number',
				get 'x-mcp-header'() {
					badReads++;
					return 'Value';
				},
			},
		},
	};
	expect(() => toolHeaderParameters(invalid)).toThrow();
	const rejectedReads = badReads;
	expect(() => toolHeaderParameters(invalid)).toThrow();
	expect(badReads).toBe(rejectedReads);
	expect(
		toolHeaderParameters({
			properties: {
				value: {
					type: 'string',
					'x-mcp-header': 'Updated',
				},
			},
		})[0]?.name,
	).toBe('Updated');
});

test('only static primitive property paths are valid header sources', () => {
	for (const schema of [
		{
			'x-mcp-header': 'Root',
			type: 'string',
		},
		{
			properties: {
				a: {
					type: 'string',
					'x-mcp-header': '',
				},
			},
		},
		{
			properties: {
				a: {
					type: 'string',
					'x-mcp-header': 'bad name',
				},
			},
		},
		{
			properties: {
				a: {
					type: 'string',
					'x-mcp-header': 'Same',
				},
				b: {
					type: 'boolean',
					'x-mcp-header': 'same',
				},
			},
		},
		{
			properties: {
				a: {
					type: [
						'string',
						'null',
					],
					'x-mcp-header': 'A',
				},
			},
		},
		{
			properties: {
				a: {
					type: 'array',
					items: {
						type: 'string',
						'x-mcp-header': 'A',
					},
				},
			},
		},
		{
			allOf: [
				{
					properties: {
						a: {
							type: 'string',
							'x-mcp-header': 'A',
						},
					},
				},
			],
		},
		{
			$defs: {
				a: {
					type: 'string',
					'x-mcp-header': 'A',
				},
			},
		},
		{
			patternProperties: {
				a: {
					type: 'string',
					'x-mcp-header': 'A',
				},
			},
		},
	])
		expect(() => toolHeaderParameters(schema)).toThrow();
});

test('recognized mirrors compare decoded values, safe integers, and omitted/null parameters', () => {
	const schema = {
		properties: {
			count: {
				type: 'integer',
				'x-mcp-header': 'Count',
			},
			text: {
				type: 'string',
				'x-mcp-header': 'Text',
			},
			flag: {
				type: 'boolean',
				'x-mcp-header': 'Flag',
			},
		},
	};
	const args = {
		count: 42,
		text: '\ufeffこんにちは',
		flag: false,
	};
	const headers = protocolHeaders(
		'tools/call',
		{
			name: 'echo',
			arguments: args,
		},
		schema,
	);
	const rules = toolHeaderParameters(schema);
	headers.set('Mcp-Param-Count', '42.0');
	headers.set('Mcp-Param-Unknown', 'opaque');
	expect(validateToolHeaders(headers, args, rules)).toBeUndefined();
	for (const count of [
		'0x2a',
		'',
		'Infinity',
		'42.1',
		'9007199254740992',
	]) {
		headers.set('Mcp-Param-Count', count);
		expect(validateToolHeaders(headers, args, rules)).toBeDefined();
	}
	expect(
		validateToolHeaders(
			new Headers({
				'Mcp-Param-Count': '0',
			}),
			{
				count: null,
			},
			rules,
		),
	).toBeDefined();
	expect(
		validateToolHeaders(
			new Headers({
				'Mcp-Param-Count': '0',
			}),
			{},
			rules,
		),
	).toBeDefined();
	expect(
		validateToolHeaders(
			new Headers(),
			{
				count: null,
			},
			rules,
		),
	).toBeUndefined();
	expect(
		validateToolHeaders(
			new Headers(),
			{
				count: 0,
			},
			rules,
		),
	).toBeDefined();
});
