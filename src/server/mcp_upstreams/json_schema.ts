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

type Engine = typeof Ajv | typeof Ajv2019 | typeof Ajv2020;

// One instance per dialect: creating one compiles its meta-schema and formats,
// which is far slower than compiling a tool schema. addUsedSchema: false keeps
// provider $ids out of the shared instance.
const engines = new Map<Engine, Ajv>();
const engineFor = (Engine: Engine): Ajv => {
	let ajv = engines.get(Engine);
	if (!ajv) {
		ajv = new Engine({
			strict: false,
			logger: false,
			allErrors: false,
			ownProperties: true,
			addUsedSchema: false,
		});
		addFormats(ajv);
		engines.set(Engine, ajv);
	}
	return ajv;
};

// Ajv caches every schema object it compiles; forget it so replaced catalogs
// are not retained. removeSchema also drops what Ajv holds under the object's
// $id, so skip it when that $id names a schema Ajv holds (a meta-schema).
const forget = (ajv: Ajv, schema: Record<string, unknown>): void => {
	const id = schema.$id;
	// Ajv rejects a non-string $id before caching the schema.
	if (id !== undefined && typeof id !== 'string') return;
	const key = id?.replace(/#\/?$/, '') ?? '';
	if (!ajv.schemas[key] && !ajv.refs[key]) ajv.removeSchema(schema);
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
				const ajv = engineFor(Engine);
				const input = {
					...record,
					$schema:
						Engine === Ajv
							? 'http://json-schema.org/draft-07/schema#'
							: normalizedDialect,
				};
				// compile validates the schema too; no separate repeated meta-schema
				// pass. No loadSchema/compileAsync, coercion, defaults, or stripping.
				let validate: ReturnType<Ajv['compile']>;
				try {
					validate = ajv.compile(input);
				} finally {
					forget(ajv, input);
				}
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
