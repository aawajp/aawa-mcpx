# aawa-mcpx gateway

Model Context Protocol (MCP) gateway that aggregates multiple backend MCP servers into a single endpoint via Streamable HTTP, using Bun's native HTTP server.

## Prerequisites
- Bun (v1.3+)
- `@modelcontextprotocol/sdk` dependency (already installed)
- `mcp.json` in the project root with backend definitions

## Install
```bash
bun install
```

## Configuration

The gateway reads backend server definitions from `mcp.json` in the project root. The format follows Claude Code's MCP configuration spec.

### HTTP transport (streamable HTTP)

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      },
      "timeout": 30000,
      "enabled": true
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"http"` | Yes | Transport type |
| `url` | string | Yes | Backend MCP server URL |
| `headers` | object | No | Custom headers (supports `${ENV_VAR}` expansion) |
| `timeout` | number | No | Request timeout in ms (default: 30000) |
| `enabled` | boolean | No | Set `false` to disable without removing |

### Stdio transport (not yet supported)

Stdio transport support is planned for a future release:

```json
{
  "mcpServers": {
    "local-server": {
      "type": "stdio",
      "command": "/path/to/server",
      "args": ["--config", "config.json"],
      "env": {
        "API_KEY": "${API_KEY}"
      },
      "enabled": true
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"stdio"` | Yes | Transport type |
| `command` | string | Yes | Path to server executable |
| `args` | string[] | No | Command line arguments |
| `env` | object | No | Environment variables (supports `${ENV_VAR}` expansion) |
| `enabled` | boolean | No | Set `false` to disable without removing |

## Run the gateway

```bash
# Development with hot reload
bun dev

# Production
bun start

# Or run directly with custom port
PORT=4000 bun src/index.ts
```

The MCP endpoint is served at `http://localhost:<PORT>/mcp` (default port `4567` if `PORT` is unset).
The gateway responds with MCP `protocolVersion` `2025-11-25`.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP) |
| `/mcp` | DELETE | Terminate MCP session |
| `/` | GET | React UI dashboard (no build step required) |
| `/ui/overview` | GET | Aggregated snapshot JSON used by the UI |
| `/ui/events` | GET | SSE stream for real-time UI updates |
| `/health` | GET | Health check with per-backend connectivity status |
| `/debug` | GET | Debug summary (client + all backend traffic) |
| `/debug/client` | GET | Paginated client traffic (`?limit=&offset=`) |
| `/debug/backend` | GET | Paginated backend traffic (`?backend=&method=&limit=&offset=`) |

Traffic is persisted to `db/traffic.db` via Bun SQLite. The frontend debug section reads from the same data.

## Using the gateway

Point your MCP client to the gateway:
```json
{
  "mcpServers": {
    "aawa-gateway": {
      "type": "http",
      "url": "http://localhost:4567/mcp"
    }
  }
}
```

### Namespacing

Tools, prompts, and resources are namespaced to avoid conflicts across backends:
- Tools/Prompts: `serverName__itemName` (double underscore separator)
- Resources: `serverName://original/uri`

## Scripts

| Script | Description |
|--------|-------------|
| `bun dev` | Development with hot reload |
| `bun start` | Production run |
| `bun lint` | Type check and lint (only supported lint command) |

## UI routing

The SPA currently uses minimal in-app state for navigation (no router). Consider adopting a router (e.g., TanStack Router: https://tanstack.com/router/latest/docs/framework/react/overview) if more pages are added.

No separate build step is needed; Bun runs TypeScript natively.
