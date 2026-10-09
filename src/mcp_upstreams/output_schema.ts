import {
	createJsonSchemaCompiler,
	type SchemaIssue,
} from '@/mcp_upstreams/json_schema';

type OutputSchemaIssue = SchemaIssue;

const createOutputSchemaValidator = (): ((
	schema: unknown,
	value: unknown,
) => OutputSchemaIssue | undefined) => {
	const compile = createJsonSchemaCompiler('outputSchema');
	return (schema, value) => {
		const compiled = compile(schema);
		return 'issue' in compiled ? compiled.issue : compiled.validate(value);
	};
};

export type { OutputSchemaIssue };
export { createOutputSchemaValidator };
