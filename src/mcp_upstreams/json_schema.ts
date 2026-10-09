import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { recordOf } from '@/shared/mcp_protocol';

type SchemaIssue = {
	reason:
		| 'invalid_schema'
		| 'unsupported_dialect'
		| 'validation_unavailable'
		| 'schema_mismatch';
	detail: string;
};
type CompiledSchema =
	| {
			validate: (value: unknown) => SchemaIssue | undefined;
	  }
	| {
			issue: SchemaIssue;
	  };

// ArkType owns application shapes. Ajv is limited to provider-supplied JSON
// Schema: ArkType's JSON Schema export cannot import these dialects/keywords.
const createJsonSchemaCompiler = (
	schemaName: string,
): ((schema: unknown) => CompiledSchema) => {
	// Refresh replaces schema objects. Cache compilation (including failures)
	// once per object without retaining old catalogs or sharing provider $ids.
	const cache = new WeakMap<object, CompiledSchema>();
	return (schema) => {
		const record = recordOf(schema);
		if (!record)
			return {
				issue: {
					reason: 'invalid_schema',
					detail: `${schemaName} must be a JSON Schema object`,
				},
			};
		const cached = cache.get(record);
		if (cached) return cached;
		let compiled: CompiledSchema;
		try {
			const pending = [
				{
					value: schema,
					depth: 0,
				},
			];
			let nodes = 0;
			while (pending.length) {
				const next = pending.pop();
				if (!next) break;
				if (++nodes > 10000 || next.depth > 64)
					throw new Error('Schema exceeds validation complexity limits');
				if (next.value !== null && typeof next.value === 'object')
					for (const child of Object.values(next.value))
						pending.push({
							value: child,
							depth: next.depth + 1,
						});
			}
			if (JSON.stringify(schema).length > 262144)
				throw new Error('Schema exceeds 256 KiB validation limit');
			if (record.$async)
				throw new Error('Asynchronous schemas are not supported');
			const dialect =
				record.$schema ?? 'https://json-schema.org/draft/2020-12/schema';
			const normalizedDialect =
				typeof dialect === 'string'
					? dialect.replace(/^http:/, 'https:').replace(/#$/, '')
					: '';
			const Engine =
				normalizedDialect === 'https://json-schema.org/draft/2020-12/schema'
					? Ajv2020
					: normalizedDialect === 'https://json-schema.org/draft/2019-09/schema'
						? Ajv2019
						: normalizedDialect === 'https://json-schema.org/draft-07/schema'
							? Ajv
							: undefined;
			if (!Engine) {
				compiled = {
					issue: {
						reason: 'unsupported_dialect',
						detail: `Unsupported JSON Schema dialect: ${String(dialect)}`,
					},
				};
			} else {
				const ajv = new Engine({
					strict: false,
					logger: false,
					allErrors: false,
					ownProperties: true,
					addUsedSchema: false,
				});
				addFormats(ajv);
				// compile validates the schema too; no separate repeated meta-schema
				// pass. No loadSchema/compileAsync, coercion, defaults, or stripping.
				const validate = ajv.compile({
					...record,
					$schema:
						Engine === Ajv
							? 'http://json-schema.org/draft-07/schema#'
							: normalizedDialect,
				});
				compiled = {
					validate(value) {
						try {
							if (validate(value)) return undefined;
							return {
								reason: 'schema_mismatch',
								detail: (validate.errors ?? [])
									.map(
										(error) =>
											`${error.instancePath || '/'} ${error.message ?? error.keyword}`,
									)
									.join('; '),
							};
						} catch (error) {
							return {
								reason: 'validation_unavailable',
								detail: error instanceof Error ? error.message : String(error),
							};
						}
					},
				};
			}
		} catch (error) {
			compiled = {
				issue: {
					reason: 'validation_unavailable',
					detail: error instanceof Error ? error.message : String(error),
				},
			};
		}
		cache.set(record, compiled);
		return compiled;
	};
};

export type { CompiledSchema, SchemaIssue };
export { createJsonSchemaCompiler };
