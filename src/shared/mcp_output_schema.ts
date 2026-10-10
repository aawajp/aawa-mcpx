import { recordOf } from '@/shared/mcp_protocol';

const requiresOutputWrapper = (schema: unknown): boolean => {
	const record = recordOf(schema);
	// A schema without an object-only root can also accept non-object values.
	return record !== undefined && record.type !== 'object';
};

const wrapOutputSchema = (schema: unknown, toolName: string): unknown => {
	const record = recordOf(schema);
	if (!record || !requiresOutputWrapper(record)) return schema;
	// A `$ref` beside `$id` makes common validators (Ajv) recurse forever, and
	// draft-07 ignores `$ref` siblings. In `allOf` it applies in every draft.
	const { $ref, ...rest } = record;
	const value =
		$ref === undefined
			? record
			: {
					...rest,
					allOf: [
						{
							$ref,
						},
						...(Array.isArray(rest.allOf) ? rest.allOf : []),
					],
				};
	return {
		$schema: record.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			value: {
				// An embedded schema resource preserves root-relative refs and anchors.
				$id: `urn:aawa-mcpx:output-schema:${encodeURIComponent(toolName)}`,
				...value,
			},
		},
		required: ['value'],
		additionalProperties: false,
	};
};

export { requiresOutputWrapper, wrapOutputSchema };
