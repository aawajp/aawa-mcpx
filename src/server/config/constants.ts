import path from 'node:path';

const CONFIG_FILENAME = 'mcp.json';
const TRAFFIC_DATABASE_FILENAME = path.join('db', 'traffic.db');
const MAIN_DATABASE_FILENAME = path.join('db', 'main.db');

export { CONFIG_FILENAME, MAIN_DATABASE_FILENAME, TRAFFIC_DATABASE_FILENAME };
