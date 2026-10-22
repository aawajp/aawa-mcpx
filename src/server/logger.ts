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

const logger = {
	debug: (message: string) => write('debug', message),
	info: (message: string) => write('info', message),
	warn: (message: string) => write('warn', message),
	error: (message: string) => write('error', message),
};

export { escapeControls, logger };
