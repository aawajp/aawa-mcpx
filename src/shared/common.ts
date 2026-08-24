import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const MAX_BODY_PREVIEW = 100;
const UNKNOWN_ERROR = 'Unknown error';

type ErrorLike = {
	message?: unknown;
	code?: unknown;
	data?: unknown;
};

const toJson = (value: unknown): string | null => {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === 'string' ? serialized : null;
	} catch {
		return null;
	}
};

const toMessage = (value: unknown): string => {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	if (value instanceof Error) {
		if (value.message) return value.message;
		if (value.name) return value.name;
		return UNKNOWN_ERROR;
	}
	if (value === null || value === undefined) {
		return UNKNOWN_ERROR;
	}
	if (typeof value === 'object') {
		const message = (value as ErrorLike).message;
		if (typeof message === 'string' && message.length > 0) {
			return message;
		}
		const fallback = toJson(value);
		if (fallback) return fallback;
		return UNKNOWN_ERROR;
	}
	return String(value);
};

const errorMessage = (error: unknown): string => {
	const errorLike =
		typeof error === 'object' && error !== null
			? (error as ErrorLike)
			: undefined;
	const code =
		errorLike && typeof errorLike.code === 'number'
			? errorLike.code
			: undefined;
	const body = toMessage(error);
	const preview = body.slice(0, MAX_BODY_PREVIEW);
	const message =
		typeof code === 'number' && code >= 100 ? `HTTP ${code}: ${preview}` : body;
	if (!errorLike) return message;
	const data = errorLike.data;
	if (data === undefined || data === null) return message;
	const serializedData = toJson(data);
	if (!serializedData) return message;
	return `${message} ${serializedData}`;
};

const cn = (...inputs: ClassValue[]) => {
	return twMerge(clsx(inputs));
};

export { cn, errorMessage };
