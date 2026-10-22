type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// One record per line: control characters, such as a newline in a name an
// MCP client reports, are written as JSON escapes.
const escapeControls = (message: string) =>
	message.replace(/\p{Cc}/gu, (char) =>
		char === '\n' || char === '\r' || char === '\t'
			? JSON.stringify(char).slice(1, -1)
			: `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);

const write = (level: LogLevel, message: string) => {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] [${level}] ${escapeControls(message)}`);
};

type LogField = string | number | boolean | readonly string[] | undefined;

// snake_case `key=value` fields, ready for structured logs: a missing value is
// `none`, a list is `[a,b]`, and text with spaces, quotes, commas or brackets
// is JSON-quoted.
const logFields = (fields: Record<string, LogField>): string => {
	const text = (value: string) =>
		/^[^\s"'=,[\]]+$/.test(value) ? value : JSON.stringify(value);
	return Object.entries(fields)
		.map(
			([key, value]) =>
				`${key}=${
					value === undefined
						? 'none'
						: Array.isArray(value)
							? `[${value.map(text).join(',')}]`
							: typeof value === 'string'
								? text(value)
								: String(value)
				}`,
		)
		.join(' ');
};

const logger = {
	debug: (message: string) => write('debug', message),
	info: (message: string) => write('info', message),
	warn: (message: string) => write('warn', message),
	error: (message: string) => write('error', message),
};

export type { LogField };
export { escapeControls, logFields, logger };
