import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { recordOf } from '@/shared/mcp_protocol';

type OutputSchemaIssue = {
	reason:
		| 'invalid_schema'
		| 'unsupported_dialect'
		| 'validation_unavailable'
		| 'schema_mismatch';
	detail: string;
};
type CompiledSchema =
	| {
			validate: ValidateFunction;
	  }
	| {
			issue: OutputSchemaIssue;
	  };

const createOutputSchemaValidator = (): ((
	schema: unknown,
	value: unknown,
) => OutputSchemaIssue | undefined) => {
	// Catalog objects are replaced on refresh. Weak keys avoid retaining old catalogs
	// and keep providers with identical $id values in separate validator instances.
	const cache = new WeakMap<object, CompiledSchema>();
	return (schema, value) => {
		const record = recordOf(schema);
		if (!record)
			return {
				reason: 'invalid_schema',
				detail: 'outputSchema must be a JSON Schema object',
			};
		let compiled = cache.get(record);
		if (!compiled) {
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
						: normalizedDialect ===
								'https://json-schema.org/draft/2019-09/schema'
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
				}
				if (Engine) {
					const ajv = new Engine({
						strict: false,
						logger: false,
						allErrors: false,
						ownProperties: true,
						addUsedSchema: false,
					});
					addFormats(ajv);
					// No loadSchema/compileAsync: external refs never trigger network I/O.
					compiled = {
						validate: ajv.compile({
							...record,
							$schema:
								Engine === Ajv
									? 'http://json-schema.org/draft-07/schema#'
									: normalizedDialect,
						}),
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
			if (!compiled)
				return {
					reason: 'validation_unavailable',
					detail: 'Could not compile outputSchema',
				};
			cache.set(record, compiled);
		}
		if ('issue' in compiled) return compiled.issue;
		try {
			if (compiled.validate(value)) return undefined;
			return {
				reason: 'schema_mismatch',
				detail: (compiled.validate.errors ?? [])
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
	};
};

export type { OutputSchemaIssue };
export { createOutputSchemaValidator };
