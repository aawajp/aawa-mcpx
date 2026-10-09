import { type } from 'arktype';

import {
	type CompiledSchema,
	createJsonSchemaCompiler,
} from '@/mcp_upstreams/json_schema';
import { jsonObjectType } from '@/shared/mcp_schemas';

// All supported MCP revisions require an object input schema with type: object.
// This wire shape is ArkType's job; dynamic JSON Schema semantics use Ajv.
const inputSchemaType = type({
	type: "'object'",
	'[string]': 'unknown',
}).and(jsonObjectType);

const createInputSchemaCompiler = (): ((schema: unknown) => CompiledSchema) => {
	const compile = createJsonSchemaCompiler('inputSchema');
	return (schema) => {
		const parsed = inputSchemaType(schema);
		if (parsed instanceof type.errors)
			return {
				issue: {
					reason: 'invalid_schema',
					detail: parsed.summary,
				},
			};
		return compile(parsed);
	};
};

export { createInputSchemaCompiler };
