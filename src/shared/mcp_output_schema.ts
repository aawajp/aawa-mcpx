import { recordOf } from '@/shared/mcp_protocol';

const requiresOutputWrapper = (schema: unknown): boolean => {
	const record = recordOf(schema);
	// A schema without an object-only root can also accept non-object values.
	return record !== undefined && record.type !== 'object';
};

const wrapOutputSchema = (schema: unknown, toolName: string): unknown => {
	const record = recordOf(schema);
	if (!record || !requiresOutputWrapper(record)) return schema;
	return {
		$schema: record.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			value: {
				// An embedded schema resource preserves root-relative refs and anchors.
				$id: `urn:aawa-mcpx:output-schema:${encodeURIComponent(toolName)}`,
				...record,
			},
		},
		required: [
			'value',
		],
		additionalProperties: false,
	};
};

export { requiresOutputWrapper, wrapOutputSchema };
