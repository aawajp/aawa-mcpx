import Ajv2020 from 'ajv/dist/2020';

import { createInputSchemaCompiler } from '@/mcp_upstreams/input_schema';

import { expect, spyOn, test } from 'bun:test';

test('input schemas require an object root in every supported revision', () => {
	const compile = createInputSchemaCompiler();
	for (const schema of [
		null,
		true,
		[],
		{},
		{
			type: 'string',
		},
		{
			type: [
				'object',
				'null',
			],
		},
	]) {
		const result = compile(schema);
		expect('issue' in result && result.issue.reason).toBe('invalid_schema');
	}
	expect(
		'validate' in
			compile({
				type: 'object',
			}),
	).toBe(true);
});

test('compiled provider schemas enforce references and composition without mutating arguments', () => {
	const compiled = createInputSchemaCompiler()({
		type: 'object',
		$defs: {
			positive: {
				type: 'integer',
				minimum: 1,
			},
		},
		properties: {
			count: {
				$ref: '#/$defs/positive',
			},
			mode: {
				enum: [
					'short',
					'long',
				],
			},
			limit: {
				type: 'integer',
				default: 5,
			},
			choice: {
				oneOf: [
					{
						const: 'auto',
					},
					{
						type: 'integer',
						minimum: 1,
					},
				],
			},
		},
		required: [
			'count',
			'mode',
			'choice',
		],
		unevaluatedProperties: false,
	});
	if ('issue' in compiled) throw new Error(compiled.issue.detail);
	const args = {
		count: 2,
		mode: 'short',
		choice: 'auto',
	};
	expect(compiled.validate(args)).toBeUndefined();
	expect(args).toEqual({
		count: 2,
		mode: 'short',
		choice: 'auto',
	});
	for (const invalid of [
		{
			...args,
			count: '2',
		},
		{
			...args,
			count: 0,
		},
		{
			...args,
			mode: 'unknown',
		},
		{
			...args,
			choice: false,
		},
		{
			...args,
			extra: true,
		},
		{},
	]) {
		const original = structuredClone(invalid);
		expect(compiled.validate(invalid)?.reason).toBe('schema_mismatch');
		expect(invalid).toEqual(original);
	}
});

test('schema objects compile once, cache failures, and isolate replacement catalog ids', () => {
	const compile = createInputSchemaCompiler();
	const spy = spyOn(Ajv2020.prototype, 'compile');
	try {
		const schema = {
			$id: 'urn:fixture:input',
			type: 'object',
			required: [
				'first',
			],
		};
		const first = compile(schema);
		expect(spy).toHaveBeenCalledTimes(1);
		if ('issue' in first) throw new Error(first.issue.detail);
		for (let i = 0; i < 3; i++) {
			expect(compile(schema)).toBe(first);
			expect(
				first.validate({
					first: true,
				}),
			).toBeUndefined();
		}
		expect(spy).toHaveBeenCalledTimes(1);
		const replacement = compile({
			...schema,
			required: [
				'second',
			],
		});
		expect(spy).toHaveBeenCalledTimes(2);
		if ('issue' in replacement) throw new Error(replacement.issue.detail);
		expect(
			replacement.validate({
				first: true,
			})?.reason,
		).toBe('schema_mismatch');
		expect(
			replacement.validate({
				second: true,
			}),
		).toBeUndefined();
		const invalid = {
			type: 'object',
			properties: {
				field: {
					type: 'invalid',
				},
			},
		};
		const failed = compile(invalid);
		expect('issue' in failed).toBe(true);
		expect(compile(invalid)).toBe(failed);
		expect(spy).toHaveBeenCalledTimes(3);
	} finally {
		spy.mockRestore();
	}
});

test('unsupported dialects, unresolved references and oversized schemas fail without network access', () => {
	const compile = createInputSchemaCompiler();
	const fetch = spyOn(globalThis, 'fetch');
	try {
		let nested: Record<string, unknown> = {
			type: 'object',
		};
		for (let i = 0; i < 70; i++)
			nested = {
				type: 'object',
				properties: {
					child: nested,
				},
			};
		for (const schema of [
			{
				type: 'object',
				$schema: 'https://example.invalid/dialect',
			},
			{
				type: 'object',
				$ref: 'https://example.invalid/schema',
			},
			{
				type: 'object',
				$async: true,
			},
			{
				type: 'object',
				description: 'x'.repeat(262144),
			},
			{
				type: 'object',
				enum: Array.from(
					{
						length: 10001,
					},
					() => ({}),
				),
			},
			nested,
		])
			expect('issue' in compile(schema)).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
