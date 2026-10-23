import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';

import { createOutputSchemaValidator } from '@/server/mcp_upstreams/output_schema';
import {
	requiresOutputWrapper,
	wrapOutputSchema,
} from '@/shared/mcp_output_schema';

import { expect, it, spyOn } from 'bun:test';

it('default 2020-12 validation supports refs, conditionals and fractional multiples', () => {
	const validate = createOutputSchemaValidator();
	const schema = {
		type: 'object',
		$defs: {
			amount: {
				type: 'number',
				multipleOf: 0.5,
			},
		},
		properties: {
			amount: {
				$ref: '#/$defs/amount',
			},
			kind: {
				enum: ['paid', 'free'],
			},
		},
		required: ['kind', 'amount'],
		if: {
			properties: {
				kind: {
					const: 'free',
				},
			},
		},
		// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
		then: {
			properties: {
				amount: {
					const: 0,
				},
			},
		},
		else: {
			properties: {
				amount: {
					exclusiveMinimum: 0,
				},
			},
		},
		unevaluatedProperties: false,
	};
	expect(
		validate(schema, {
			kind: 'paid',
			amount: 1.5,
		}),
	).toBeUndefined();
	for (const value of [
		{
			kind: 'free',
			amount: 1,
		},
		{
			kind: 'paid',
			amount: 1.1,
		},
		{
			kind: 'paid',
		},
		{
			kind: 'paid',
			amount: 1,
			extra: true,
		},
	])
		expect(validate(schema, value)?.reason).toBe('schema_mismatch');
});

it('2020-12 array, composition and dependency keywords are enforced', () => {
	const validate = createOutputSchemaValidator();
	const schema = {
		type: 'array',
		prefixItems: [
			{
				type: 'string',
			},
		],
		items: {
			type: 'integer',
		},
		minItems: 2,
		contains: {
			const: 3,
		},
		minContains: 1,
		maxContains: 1,
	};
	expect(validate(schema, ['first', 3])).toBeUndefined();
	expect(validate(schema, ['first', 3, 3])?.reason).toBe('schema_mismatch');
	expect(validate(schema, ['first', 3, 'invalid'])?.reason).toBe(
		'schema_mismatch',
	);
	const object = {
		type: 'object',
		properties: {
			count: {
				oneOf: [
					{
						const: 1,
					},
					{
						const: 2,
					},
				],
			},
			total: {
				type: 'integer',
			},
		},
		dependentRequired: {
			count: ['total'],
		},
	};
	expect(
		validate(object, {
			count: 1,
			total: 2,
		}),
	).toBeUndefined();
	expect(
		validate(object, {
			count: 3,
			total: 2,
		})?.reason,
	).toBe('schema_mismatch');
	expect(
		validate(object, {
			count: 1,
		})?.reason,
	).toBe('schema_mismatch');
});

for (const $schema of [
	'http://json-schema.org/draft-07/schema#',
	'https://json-schema.org/draft-07/schema',
	'https://json-schema.org/draft/2019-09/schema',
	'https://json-schema.org/draft/2020-12/schema',
])
	it(`accepts the supported dialect declaration ${$schema}`, () => {
		const validate = createOutputSchemaValidator();
		const schema = {
			$schema,
			type: 'integer',
			minimum: 2,
		};
		expect(validate(schema, 2)).toBeUndefined();
		expect(validate(schema, '2')?.reason).toBe('schema_mismatch');
	});

it('schema failures are reported without resolving external references or mutating data', () => {
	const validate = createOutputSchemaValidator();
	const fetch = spyOn(globalThis, 'fetch');
	try {
		expect(
			validate(
				{
					$ref: 'https://example.invalid/schema',
				},
				{},
			)?.reason,
		).toBe('validation_unavailable');
		expect(fetch).not.toHaveBeenCalled();
		expect(
			validate(
				{
					$schema: 'https://example.invalid/dialect',
				},
				{},
			)?.reason,
		).toBe('unsupported_dialect');
		expect(
			validate(
				{
					type: 'invalid',
				},
				{},
			)?.reason,
		).toBe('validation_unavailable');
		expect(validate(null, {})?.reason).toBe('invalid_schema');
		const data = {
			value: '2',
			extra: true,
		};
		expect(
			validate(
				{
					type: 'object',
					properties: {
						value: {
							type: 'integer',
						},
						missing: {
							default: 1,
						},
					},
					additionalProperties: false,
				},
				data,
			)?.reason,
		).toBe('schema_mismatch');
		expect(data).toEqual({
			value: '2',
			extra: true,
		});
	} finally {
		fetch.mockRestore();
	}
});

it('cache is isolated for schemas with the same id and accepts replacement catalogs', () => {
	const validate = createOutputSchemaValidator();
	const first = {
		$id: 'urn:aawa-mcpx:shared',
		type: 'string',
	};
	const second = {
		$id: 'urn:aawa-mcpx:shared',
		type: 'number',
	};
	expect(validate(first, 'works')).toBeUndefined();
	expect(validate(second, 1)).toBeUndefined();
	expect(validate(second, 'works')?.reason).toBe('schema_mismatch');
});

it('schema complexity limits report unavailable validation', () => {
	let schema: Record<string, unknown> = {
		type: 'string',
	};
	for (let i = 0; i < 70; i++)
		schema = {
			type: 'array',
			items: schema,
		};
	expect(createOutputSchemaValidator()(schema, [])?.reason).toBe(
		'validation_unavailable',
	);
});

for (const $schema of [
	undefined,
	'http://json-schema.org/draft-07/schema#',
	'https://json-schema.org/draft/2019-09/schema',
])
	it(`object wrappers preserve root refs for ${$schema ?? '2020-12'}`, () => {
		const schema = {
			...($schema
				? {
						$schema,
					}
				: {}),
			type: 'array',
			$defs: {
				item: {
					type: 'integer',
				},
			},
			items: {
				$ref: '#/$defs/item',
			},
		};
		const wrapped = wrapOutputSchema(schema, 'backend__tool');
		const validate = createOutputSchemaValidator();
		expect(
			validate(wrapped, {
				value: [1, 2],
			}),
		).toBeUndefined();
		expect(
			validate(wrapped, {
				value: ['bad'],
			})?.reason,
		).toBe('schema_mismatch');
		expect(validate(wrapped, [1, 2])?.reason).toBe('schema_mismatch');
		expect(requiresOutputWrapper(schema)).toBe(true);
	});

it('object wrappers preserve recursive refs and anchors and avoid changing object schemas', () => {
	const recursive = {
		type: ['object', 'null'],
		$defs: {
			node: {
				$anchor: 'node',
				type: 'object',
				properties: {
					next: {
						anyOf: [
							{
								$ref: '#node',
							},
							{
								type: 'null',
							},
						],
					},
				},
			},
		},
		anyOf: [
			{
				$ref: '#node',
			},
			{
				type: 'null',
			},
		],
	};
	expect(
		createOutputSchemaValidator()(wrapOutputSchema(recursive, 'tree'), {
			value: {
				next: {
					next: null,
				},
			},
		}),
	).toBeUndefined();
	const object = {
		type: 'object',
		properties: {
			count: {
				type: 'number',
			},
		},
	};
	expect(wrapOutputSchema(object, 'count')).toBe(object);
});

it('object wrappers keep a root $ref compilable in draft-07 and 2020-12', () => {
	// zod-to-json-schema emits a root $ref; client SDKs compile it with Ajv.
	for (const [Validator, schema] of [
		[
			Ajv,
			{
				$schema: 'http://json-schema.org/draft-07/schema#',
				$ref: '#/definitions/list',
				definitions: {
					list: {
						type: 'array',
						items: {
							type: 'integer',
						},
					},
				},
			},
		],
		[
			Ajv2020,
			{
				$ref: '#/$defs/list',
				$defs: {
					list: {
						type: 'array',
						items: {
							type: 'integer',
						},
					},
				},
			},
		],
	] as const) {
		const wrapped = wrapOutputSchema(schema, 'backend__list');
		const validate = new Validator({
			strict: false,
		}).compile(wrapped as object);
		expect(
			validate({
				value: [1],
			}),
		).toBe(true);
		expect(
			validate({
				value: ['bad'],
			}),
		).toBe(false);
		expect(
			createOutputSchemaValidator()(wrapped, {
				value: ['bad'],
			})?.reason,
		).toBe('schema_mismatch');
	}
});

it('one validator checks formats, and keeps each compiled schema', () => {
	const validate = createOutputSchemaValidator();
	const schemaOf = (format: string) => ({
		type: 'object',
		properties: {
			value: {
				type: 'string',
				format,
			},
		},
	});
	const email = schemaOf('email');
	const date = schemaOf('date');
	for (let round = 0; round < 2; round++) {
		expect(validate(email, { value: 'a@example.com' })).toBeUndefined();
		expect(validate(email, { value: 'not an email' })?.reason).toBe(
			'schema_mismatch',
		);
		expect(validate(date, { value: '2026-10-20' })).toBeUndefined();
		expect(validate(date, { value: 'a@example.com' })?.reason).toBe(
			'schema_mismatch',
		);
	}
});

it('a schema with a meta-schema $id does not break later schemas', () => {
	const validate = createOutputSchemaValidator();
	for (const $id of [
		'https://json-schema.org/draft/2020-12/schema',
		'http://json-schema.org/draft-07/schema#',
	]) {
		validate(
			{
				$schema: $id,
				$id,
				type: 'string',
			},
			'works',
		);
		expect(
			validate(
				{
					$schema: $id,
					type: 'number',
				},
				'works',
			)?.reason,
		).toBe('schema_mismatch');
	}
});
