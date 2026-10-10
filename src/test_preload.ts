import { logger } from '@/server/logger';

// Tests check log calls with spies; printing every line only buries failures.
for (const level of [
	'debug',
	'info',
	'warn',
	'error',
] as const)
	logger[level] = () => undefined;
