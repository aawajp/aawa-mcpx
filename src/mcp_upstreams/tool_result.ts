import type { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { createOutputSchemaValidator } from '@/mcp_upstreams/output_schema';
import { logger } from '@/server/logger';
import { recordOf } from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';

// MCP recommends (SHOULD) serialized JSON text alongside structuredContent for
// compatibility. The gateway deliberately omits that duplicate to avoid sending
// the same data twice. Independent text and other content can accompany structured
// output, so the presence of structuredContent alone never justifies dropping them.
// https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content
const stripDuplicateToolContent = <
	T extends {
		content: CallToolResult['content'];
		structuredContent?: unknown;
	},
>(
	result: T,
): T => {
	if (result.structuredContent === undefined || !Array.isArray(result.content))
		return result;

	const content = result.content.filter((block) => {
		if (block.type !== 'text') return true;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block.text);
		} catch {
			// Ordinary text and malformed JSON are independent content.
			return true;
		}
		// Compare the complete JSON value, ignoring formatting and object key order.
		// A subset, a summary, or JSON with additional fields is independent content.
		return !Bun.deepEquals(parsed, result.structuredContent, true);
	});
	return {
		...result,
		content,
	};
};

const createToolResultNormalizer = (): ((
	result: ToolCallResult,
	schema: unknown,
	context: {
		backend: string;
		tool: string;
		protocolVersion?: string;
	},
) => ToolCallResult) => {
	const validate = createOutputSchemaValidator();
	return (result, schema, context) => {
		// Error results describe failures rather than the tool's success contract.
		if (result.isError) return stripDuplicateToolContent(result);
		const warn = (reason: string, detail: string): void =>
			logger.warn(
				JSON.stringify({
					message: 'MCP tool output schema warning',
					context: {
						...context,
						reason,
					},
					error: detail.slice(0, 2000),
				}),
			);
		let normalized = result;
		if (result.structuredContent === undefined) {
			const candidates: unknown[] = [];
			const parsedBlocks: unknown[] = [];
			for (const block of result.content) {
				if (block.type !== 'text') continue;
				if (block.text.length > 2097152) continue;
				try {
					const parsed: unknown = JSON.parse(block.text);
					parsedBlocks.push(parsed);
					if (
						!candidates.some((candidate) =>
							Bun.deepEquals(candidate, parsed, true),
						)
					)
						candidates.push(parsed);
				} catch {
					// Prose and partial JSON cannot safely reconstruct structured output.
				}
			}
			let matches = candidates;
			if (
				schema !== undefined &&
				(candidates.length > 1 ||
					(recordOf(schema)?.type === 'array' && parsedBlocks.length > 0))
			) {
				matches = candidates.filter(
					(candidate) => validate(schema, candidate) === undefined,
				);
				// Some SDKs return one JSON text block per array item.
				if (
					matches.length !== 1 &&
					recordOf(schema)?.type === 'array' &&
					validate(schema, parsedBlocks) === undefined
				)
					matches = [
						parsedBlocks,
					];
			}
			if (matches.length === 1) {
				normalized = {
					...result,
					structuredContent: matches[0],
				};
				if (schema !== undefined)
					warn(
						'structured_content_recovered',
						'Missing structuredContent recovered from JSON text in content',
					);
			}
			if (matches.length !== 1 && schema !== undefined) {
				warn(
					'missing_structured_content',
					candidates.length
						? 'Missing structuredContent; content contains ambiguous JSON values'
						: 'Missing structuredContent; content has no complete JSON value within recovery limits',
				);
				// Even without data, report malformed schemas and unresolved references.
				const issue = validate(schema, undefined);
				if (issue && issue.reason !== 'schema_mismatch')
					warn(issue.reason, issue.detail);
				return result;
			}
		}
		if (schema !== undefined && normalized.structuredContent !== undefined) {
			const issue = validate(schema, normalized.structuredContent);
			// MCP requires conforming structured results (MUST). As an aggregator we
			// deliberately tolerate provider violations: warn, preserve the data, and
			// let the client decide how to handle the mismatch rather than fail the call.
			// https://modelcontextprotocol.io/specification/2026-07-28/server/tools#output-schema
			if (issue) warn(issue.reason, issue.detail);
		}
		return stripDuplicateToolContent(normalized);
	};
};

export { createToolResultNormalizer, stripDuplicateToolContent };
