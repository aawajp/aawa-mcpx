import { type } from 'arktype';

const clientInfoType = type({
	name: 'string',
	version: 'string',
	'title?': 'string',
});
type ClientInfo = typeof clientInfoType.infer;

// Keep the whole reported object, including fields the dashboard does not show.
const parseClientInfo = (value: unknown): ClientInfo | undefined =>
	clientInfoType.allows(value) ? value : undefined;

const formatClientInfo = (client: ClientInfo): string =>
	client.version ? `${client.name}@${client.version}` : client.name;

export type { ClientInfo };
export { clientInfoType, formatClientInfo, parseClientInfo };
