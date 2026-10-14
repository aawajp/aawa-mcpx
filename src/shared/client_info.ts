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

export type { ClientInfo };
export { clientInfoType, parseClientInfo };
