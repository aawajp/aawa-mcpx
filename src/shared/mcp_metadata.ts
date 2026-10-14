import { type } from 'arktype';

import { clientInfoType } from '@/shared/client_info';
import {
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	PROTOCOL_VERSION_META,
} from '@/shared/mcp_protocol';
import { iconType, jsonObjectType } from '@/shared/mcp_schemas';

// The 2026 schema adds extensions and removes legacy roots.listChanged. Known
// capability fields are checked; unknown fields remain available to extensions.
const settingsMapType = type({
	'[string]': jsonObjectType,
}).and(jsonObjectType);
const label = '[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const prefix = `${label}(?:\\.${label})*/`;
const name = '(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?';
const metadataKey = new RegExp(`^(?:${prefix})?${name}$`);
const extensionKey = new RegExp(`^${prefix}${name}$`);
const clientCapabilitiesType = type({
	'experimental?': settingsMapType,
	'roots?': jsonObjectType,
	'sampling?': type({
		'context?': jsonObjectType,
		'tools?': jsonObjectType,
		'[string]': 'unknown',
	}).and(jsonObjectType),
	'elicitation?': type({
		'form?': jsonObjectType,
		'url?': jsonObjectType,
		'[string]': 'unknown',
	}).and(jsonObjectType),
	'extensions?': settingsMapType.narrow((value) =>
		Object.keys(value).every((key) => extensionKey.test(key)),
	),
	'[string]': 'unknown',
}).and(jsonObjectType);

// Legacy metadata is optional and has no per-request protocol envelope. Validate
// it at dispatch only; the modern HTTP boundary already validates its metadata.
const legacyRequestMetadataType = type({
	'progressToken?': 'string | number.integer',
	'[string]': 'unknown',
})
	.and(jsonObjectType)
	.narrow((value) => Object.keys(value).every((key) => metadataKey.test(key)));

const requestMetadataType = type({
	[PROTOCOL_VERSION_META]: 'string',
	[CLIENT_CAPABILITIES_META]: clientCapabilitiesType,
	[`${CLIENT_INFO_META}?`]: clientInfoType
		.and({
			'description?': 'string',
			'websiteUrl?': 'string.url',
			'icons?': iconType.array(),
			'[string]': 'unknown',
		})
		.and(jsonObjectType),
	'io.modelcontextprotocol/logLevel?':
		"'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'",
	'progressToken?': 'string | number.integer',
	'[string]': 'unknown',
})
	.and(jsonObjectType)
	.narrow((value) => Object.keys(value).every((key) => metadataKey.test(key)));

export { legacyRequestMetadataType, requestMetadataType };
