import { type } from 'arktype';

import { errorMessage } from '@/shared/common';

const jsonError = (status: number, message: string): Response =>
	Response.json(
		{
			error: message,
		},
		{
			status,
		},
	);

// The request's query parameters, or the 400 answer when they are invalid.
const readQuery = <T>(
	queryType: (value: unknown) => T | type.errors,
	url: string,
): T | Response => {
	const query = queryType(Object.fromEntries(new URL(url).searchParams));
	return query instanceof type.errors
		? jsonError(400, `Invalid query: ${query.summary}`)
		: query;
};

// The request's JSON body, or the 400 answer when it is invalid; `onInvalid`
// gets the reason first, for a log line.
const readBody = async <T>(
	bodyType: { assert: (value: unknown) => T },
	request: Request,
	onInvalid?: (error: string) => void,
): Promise<T | Response> => {
	try {
		return bodyType.assert(await request.json());
	} catch (error) {
		onInvalid?.(errorMessage(error));
		return jsonError(400, `Invalid request body: ${errorMessage(error)}`);
	}
};

export { jsonError, readBody, readQuery };
