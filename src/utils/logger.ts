type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const write = (level: LogLevel, message: string) => {
	const timestamp = new Date().toISOString();
	// eslint-disable-next-line no-console
	console.log(`[${timestamp}] [${level}] ${message}`);
};

const logger = {
	debug: (message: string) => write('debug', message),
	info: (message: string) => write('info', message),
	warn: (message: string) => write('warn', message),
	error: (message: string) => write('error', message),
};

export { logger };
