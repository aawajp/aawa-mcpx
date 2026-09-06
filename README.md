# aawa-mcpx gateway

Model Context Protocol (MCP) gateway that aggregates multiple backend MCP servers into a single endpoint via Streamable HTTP, using Bun's native HTTP server.

For architecture and source layout details, see [DESIGN.md](DESIGN.md).

## Prerequisites
- Bun 1.4 or newer
- `mcp.json` in the project root with backend definitions

## Install
```bash
bun install
```

## Configuration

The gateway reads backend server definitions from the `mcpServers` object in `mcp.json` at startup. Runtime state is held in memory; dashboard changes overwrite `mcp.json`, and external edits require a restart.

### HTTP transport (streamable HTTP)

HTTP backends must expose MCP Streamable HTTP. Streamable HTTP `POST` responses may use JSON or SSE. aawa-mcpx disables the optional standalone `GET` event stream when connecting to backends because catalogs are refreshed through explicit requests and health checks.

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-token"
      },
      "timeout": 10000,
      "enabled": true,
      "enabledTools": ["search", "fetch"]
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"http"` | Yes | Transport type |
| `url` | string | Yes | Backend MCP server URL |
| `headers` | object | No | Literal custom header values |
| `timeout` | number | No | Request timeout in ms (default: 10000) |
| `enabled` | boolean | No | Connect to and expose this backend (default: true) |
| `trafficLimit` | number | No | Rate used to space requests (default: 1 request/s; concurrent calls are not serialized) |
| `enabledTools` | string[] | No | List of tool names exposed to MCP clients (auto-initialized on first tool fetch) |
| `availableTools` | string[] | No | Tool names discovered from backend (server-managed; not for manual edits) |

If `enabledTools` contains names not present in backend `tools/list`, the backend is marked unavailable with an action-required configuration error until settings are fixed.

### Stdio transport

```json
{
  "mcpServers": {
    "local-server": {
      "type": "stdio",
      "command": "/path/to/server",
      "args": ["--config", "config.json"],
      "env": {
        "API_KEY": "replace-with-token"
      },
      "timeout": 10000,
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
| `env` | object | No | Literal environment variables passed to the process |
| `cwd` | string | No | Working directory for the spawned process |
| `timeout` | number | No | Request timeout in ms (default: 10000) |
| `enabled` | boolean | No | Start and expose this backend (default: true) |
| `trafficLimit` | number | No | Rate used to space requests (default: 1 request/s; concurrent calls are not serialized) |
| `enabledTools` | string[] | No | List of tool names exposed to MCP clients (auto-initialized on first tool fetch) |
| `availableTools` | string[] | No | Tool names discovered from backend (server-managed; not for manual edits) |

`mcp.json` is local configuration and is ignored by Git. Keep backend credentials there rather than in tracked files.

## Run the gateway

### Local development

```bash
# Development with hot reload
bun dev

# Production
bun start

# Or run directly with custom port
PORT=4000 bun src/index.ts
```

Bun executes the TypeScript source directly; there is no separate local build step.

### Docker

```bash
# Build and run with Docker Compose
docker compose up --build

# Or build and run manually
docker build -t aawa-mcpx .
docker run -p 4567:4567 -v $(pwd)/mcp.json:/home/app/mcp.json:rw -v $(pwd)/db:/home/app/db aawa-mcpx
```

Docker Compose mounts `mcp.json` for configuration and tool-state updates, mounts `db` for SQLite storage, and passes `.env` to the container. Start from `.env.example` when creating `.env`.

### Apple container CLI

Apple's `container` CLI can run the same image without Docker Desktop, OrbStack, or another Docker-compatible runtime.

```bash
container build -t local/aawa-mcpx:latest .

container create --env-file=.env --user=1000:1000 --publish=4567:4567 --volume=./mcp.json:/home/app/mcp.json --volume=./db:/home/app/db --name aawa-mcpx local/aawa-mcpx:latest

container start aawa-mcpx
```

Create `.env` from `.env.example` before using `--env-file=.env`. The `mcp.json` file and `db` directory are mounted read-write. Tool exposure changes persist in `mcp.json`; traffic history is reset when the gateway starts.

The MCP endpoint is served at `http://localhost:<PORT>/mcp` (default port `4567` if `PORT` is unset).
The gateway supports MCP protocol versions `2026-07-28`, `2025-11-25`, and `2025-06-18` on both protocol boundaries. Requests using `2026-07-28` carry their version and capabilities in per-request metadata and require the matching HTTP protocol, method, and name headers. Clients using `2025-11-25` or `2025-06-18` initialize a session; an unsupported initialization proposal receives `2025-11-25`. `2025-03-26` is no longer an operational version.

Backends select the highest mutually supported version on their first successful connection. The selection is retained across reconnects and enable/disable changes until the gateway restarts. Connections using `2025-11-25` or `2025-06-18` initialize a fresh session on reconnect using that selection. Backends using `2026-07-28` use discovery for health checks. Backend HTTP responses may be JSON or SSE; stdio uses newline-delimited JSON-RPC.

Protocol negotiation failures stop automatic reconnects and appear in the backend UI with the failed method, attempted revision, and available HTTP/JSON-RPC error codes. Disable and re-enable the backend to retry; restart the gateway if its retained protocol selection needs to change.

### Session management

For clients using `2025-11-25` or `2025-06-18`, the gateway creates a unique session ID on initialization. Sessions are stored in memory and are cleared when the gateway restarts. Requests using those revisions with an unknown session ID return HTTP 404 and must initialize a new session. Requests using `2026-07-28` do not create or require sessions; the dashboard tracks all clients by reported name and version, regardless of protocol revision. It shows first seen, last seen, and the most recently observed protocol version, without session IDs or connection status. Client activity is held in bounded memory and cleared on gateway restart. This local-use identity convention does not distinguish separate instances reporting the same name and version.

The gateway retains up to `MCP_MAX_SESSIONS_PER_CLIENT` sessions per client name/version pair (default `10`, positive integer). When a successful initialization exceeds this limit, the oldest session for that pair is deleted. Other clients are unaffected. Sessions do not expire on a timer; explicit DELETE removes a session immediately. Invalid configuration values fall back to the default.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP) |
| `/mcp` | DELETE | Terminate MCP session |
| `/` | GET | React UI dashboard (no build step required) |
| `/debug` | GET | Debug UI page |
| `/api/overview` | GET | Aggregated snapshot JSON used by the UI |
| `/api/events` | GET | SSE stream for real-time UI updates |
| `/api/backends/toggle` | POST | Enable or disable a backend (`{ serverName, enabled }`) and persist to `mcp.json` |
| `/api/tools/toggle` | POST | Toggle client-visible tool state (`{ name, enabled }`) and persist to `mcp.json` |
| `/api/tools/call` | POST | Call a backend tool for UI testing (`{ serverName, toolName, arguments }`) |
| `/api/health` | GET | Health check with per-backend connectivity status |
| `/api/debug` | GET | Debug summary (client + all backend traffic) |
| `/api/debug/client` | GET | Paginated client traffic (`?limit=&offset=`) |
| `/api/debug/backend` | GET | Paginated backend traffic (`?backend=&method=&limit=&offset=`) |

Traffic is stored in `db/traffic.db` via Bun SQLite and is reset on gateway startup. The debug UI reads from this database.

All non-MCP API endpoints are namespaced under `/api/*` to avoid collisions with UI routes.

## UI behavior

- Main page defaults to **Backends** and includes a **Tester** view for tool invocation without raw JSON.
- Backends and tools are shown in alphabetical order for stable scanability.
- Backend controls connect or disconnect each backend and persist its `enabled` value.
- A disabled backend shows its configured enabled tools as inactive; their exposure settings are preserved when the backend is re-enabled.
- Per-backend tool toggles (`Expose to clients`) are managed directly from the backend tool list.
- Tool descriptions and input schemas are folded by default.
- Protocol lists every supported revision, and each backend shows its selected protocol separately from its software version.
- Debug UI is served at `/debug`, with separate full-width **Client traffic** and **Backend traffic** tabs. Backend traffic has an alphabetical selector. Filters and pages survive tab changes; **Show all** is the default.

### Protocol feature scope

Core tools, prompts, and resources work across all three supported revisions. Interactive continuations, sampling, elicitation, subscriptions, and tasks are not advertised. Catalog results sent using `2026-07-28` include private, zero-TTL cache hints. Backend catalog pages are fully materialized, with stale `2026-07-28` catalogs refreshed on access and simultaneous refreshes deduplicated. Backend credentials define the catalog authorization context. When forwarding scalar, array, or null structured tool content to clients using `2025-11-25` or `2025-06-18`, it is represented as `{ "value": ... }` to preserve the data in the object shape required by those revisions.

The gateway owns protocol negotiation, dispatch, and HTTP/stdio transport behavior. The installed SDK supplies TypeScript types; its client/server implementations are not used.

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

## Container image workflows

The repository contains two GitHub Actions workflows:

- `ci.yml` runs for pull requests targeting `main` or `release/*`, and for pushes to `release/*`.
- `docker-build.yml` checks pull requests targeting `main` and publishes images for `release/*` pushes and `v*` tags.

Both workflows target `linux/arm64` and `linux/amd64` and use GitHub Container Registry and Docker Hub.

### Registries

- **GitHub Container Registry**: `ghcr.io/aawajp/aawa-mcpx`
- **DockerHub**: `docker.io/aawajp/aawa-mcpx`

## Scripts

| Script | Description |
|--------|-------------|
| `bun dev` | Development with hot reload |
| `bun start` | Production run |
| `bun test` | Run tests |
| `bun lint` | Type check, then run Biome with automatic fixes |
| `./scripts/checksum` | Calculate SHA256 checksum of Docker build context |

## License

Licensed under the Apache License 2.0. Copyright © 2026 Mikael Nakajima
([Aawa Technologies](https://aawa.jp)). See [LICENSE](LICENSE) for the full
license text.
