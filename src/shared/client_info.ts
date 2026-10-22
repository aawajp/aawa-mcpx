import { type } from 'arktype';

// Clients name themselves; the gateway keeps what they report in memory, so
// both the names and the whole object are limited.
const CLIENT_NAME_LENGTH = 256;
const CLIENT_INFO_BYTES = 64 * 1024;

const clientInfoType = type({
	name: `string <= ${CLIENT_NAME_LENGTH}`,
	version: `string <= ${CLIENT_NAME_LENGTH}`,
	'title?': `string <= ${CLIENT_NAME_LENGTH}`,
}).narrow(
	(value, ctx) =>
		new TextEncoder().encode(JSON.stringify(value)).length <=
			CLIENT_INFO_BYTES ||
		ctx.mustBe(`at most ${CLIENT_INFO_BYTES} bytes as JSON`),
);
type ClientInfo = typeof clientInfoType.infer;

// Keep the whole reported object, including fields the dashboard does not show.
const parseClientInfo = (value: unknown): ClientInfo | undefined =>
	clientInfoType.allows(value) ? value : undefined;

const formatClientInfo = (client: ClientInfo): string =>
	client.version ? `${client.name}@${client.version}` : client.name;

export type { ClientInfo };
export {
	CLIENT_INFO_BYTES,
	CLIENT_NAME_LENGTH,
	clientInfoType,
	formatClientInfo,
	parseClientInfo,
};
