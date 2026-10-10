import path from 'node:path';

import { CURRENT_PROTOCOL_VERSION } from '@/shared/mcp_protocol';

const MCP_PROTOCOL_VERSION = CURRENT_PROTOCOL_VERSION;
const CONFIG_FILENAME = 'mcp.json';
const DATABASE_FILENAME = path.join('db', 'traffic.db');

export { CONFIG_FILENAME, DATABASE_FILENAME, MCP_PROTOCOL_VERSION };
