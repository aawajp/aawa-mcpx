import { type } from 'arktype';

const clientInfoType = type({
	name: 'string',
	version: 'string',
	'title?': 'string',
});
type ClientInfo = typeof clientInfoType.infer;

const parseClientInfo = (value: unknown): ClientInfo | undefined => {
	if (!clientInfoType.allows(value)) return undefined;
	return {
		name: value.name,
		version: value.version,
		...(value.title !== undefined
			? {
					title: value.title,
				}
			: {}),
	};
};

const formatClientInfo = (client: ClientInfo): string =>
	client.version ? `${client.name}@${client.version}` : client.name;

export type { ClientInfo };
export { clientInfoType, formatClientInfo, parseClientInfo };
