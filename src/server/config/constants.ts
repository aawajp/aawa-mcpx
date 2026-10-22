import path from 'node:path';

const CONFIG_FILENAME = 'mcp.json';
const TRAFFIC_DATABASE_FILENAME = path.join('db', 'traffic.db');
const MAIN_DATABASE_FILENAME = path.join('db', 'main.db');

// Exit codes, so a supervisor restarts the gateway only when that can help.
// Bun also exits with 1 on an unexpected error. 75 and 78 come from sysexits.h.
const EXIT_CODES = {
	// Not recoverable: an unexpected error.
	unexpected: 1,
	// Recoverable: a temporary startup failure, such as a busy port
	// (EX_TEMPFAIL).
	temporary: 75,
	// Not recoverable: a setting, mcp.json or the main database must be fixed
	// first (EX_CONFIG).
	configuration: 78,
} as const;

export {
	CONFIG_FILENAME,
	EXIT_CODES,
	MAIN_DATABASE_FILENAME,
	TRAFFIC_DATABASE_FILENAME,
};
