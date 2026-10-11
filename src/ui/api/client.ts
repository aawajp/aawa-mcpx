import { type } from 'arktype';

import { apiErrorType } from '@/shared/ui_api';

const fetchJson = async (
	input: string,
	init?: RequestInit,
): Promise<unknown> => {
	const response = await fetch(input, init);
	if (response.ok) return response.json();
	const body = apiErrorType(await response.json().catch(() => undefined));
	throw new Error(
		body instanceof type.errors
			? `Request failed with status ${response.status}`
			: body.error,
	);
};

export { fetchJson };
