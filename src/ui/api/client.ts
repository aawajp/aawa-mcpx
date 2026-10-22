import { type } from 'arktype';
import { useRef, useState } from 'react';

import { errorMessage } from '@/shared/common';
import { apiErrorType, RETURN_TO_PARAM, UI_PAGE_PATHS } from '@/shared/ui_api';

type Page = keyof typeof UI_PAGE_PATHS;

// The dashboard page at the browser's path, which may end in a slash.
const currentPage = (): Page => {
	const path = window.location.pathname.replace(/\/$/, '');
	return (
		(['debug', 'login'] as const).find(
			(page) => UI_PAGE_PATHS[page] === path,
		) ?? 'main'
	);
};

class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

let isRedirectingToLogin = false;

const fetchJson = async (
	input: string,
	init?: RequestInit,
): Promise<unknown> => {
	const response = await fetch(input, init);
	if (response.ok) return response.json();
	// Without a valid session, the first failed call sends the browser to the
	// login page; later ones must not go there twice. On that page, a 401 is a
	// refused login.
	if (
		response.status === 401 &&
		!isRedirectingToLogin &&
		currentPage() !== 'login'
	) {
		isRedirectingToLogin = true;
		window.location.assign(
			`${UI_PAGE_PATHS.login}?${new URLSearchParams({
				[RETURN_TO_PARAM]: window.location.pathname,
			})}`,
		);
	}
	const body = apiErrorType(await response.json().catch(() => undefined));
	throw new ApiError(
		body instanceof type.errors
			? `Request failed with status ${response.status}`
			: body.error,
		response.status,
	);
};

const getJson = (input: string): Promise<unknown> =>
	fetchJson(input, {
		cache: 'no-store',
	});

const postJson = (input: string, body: unknown): Promise<unknown> =>
	fetchJson(input, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

// One request at a time: `pending` while it runs, so a double click does not
// send it twice, and `error` when it failed. `run` resolves to whether it
// succeeded.
const useRequest = () => {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// `pending` only updates on the next render, so a second call in the
	// same tick still sees false.
	const running = useRef<boolean>(false);
	const run = async (request: () => Promise<unknown>): Promise<boolean> => {
		if (running.current) return false;
		running.current = true;
		setPending(true);
		setError(null);
		try {
			await request();
			return true;
		} catch (err) {
			setError(errorMessage(err));
			return false;
		} finally {
			running.current = false;
			setPending(false);
		}
	};
	return {
		pending,
		error,
		setError,
		run,
	};
};

export type { Page };
export { ApiError, currentPage, getJson, postJson, useRequest };
