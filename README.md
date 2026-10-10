# aawa-mcpx gateway

aawa-mcpx is a Model Context Protocol (MCP) gateway. It aggregates tools, prompts,
and resources from several backend MCP servers behind one Streamable HTTP
endpoint, using Bun's native HTTP server. A built-in dashboard shows backends,
clients, and traffic, and lets you choose which tools clients see.

- Clients and backends: MCP `2026-07-28`, `2025-11-25`, and `2025-06-18`, negotiated independently.
- Backends over Streamable HTTP or stdio, with automatic reconnection and health checks.
- Per-backend namespacing, so items from different backends never collide.
- Per-tool exposure control, persisted in `mcp.json`.
- Traffic log in SQLite for debugging.

Interactive features (sampling, elicitation, subscriptions, tasks) are not
supported. [DESIGN.md](/DESIGN.md) describes the architecture, protocol
behavior, and planned design; [CHANGELOG.md](/CHANGELOG.md) lists changes.

> [!WARNING]
> The gateway has no client authentication and listens on all interfaces. Its
> dashboard API also accepts cross-site requests, so a web page open in your
> browser can call it. Run it only on a trusted network.

## Prerequisites

- Bun 1.4 or newer
- `mcp.json` in the project root with backend definitions

## Install

```bash
bun install
```

## Configuration

### Backends

Backends are defined in `mcp.json` under `mcpServers`. The file is read once at
startup. When a tool catalog fetch or a dashboard change alters `enabled`,
`enabledTools`, or `availableTools`, the gateway writes the file as it read it
with only those fields changed, so external edits made while it runs are lost;
stop the gateway before editing. `mcp.json` is ignored by Git;
keep backend credentials there rather than in tracked files.

HTTP backend:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-token"
      }
    }
  }
}
```

Stdio backend:

```json
{
  "mcpServers": {
    "local-server": {
      "type": "stdio",
      "command": "/path/to/server",
      "args": ["--config", "config.json"],
      "env": {
        "API_KEY": "replace-with-token"
      }
    }
  }
}
```

| Field | Transport | Description |
| --- | --- | --- |
| `type` | Both | `"http"` or `"stdio"` (required) |
| `url` | HTTP | Backend MCP endpoint (required) |
| `headers` | HTTP | Literal header values sent to the backend |
| `command` | stdio | Server executable (required) |
| `args` | stdio | Command-line arguments |
| `env` | stdio | Literal environment variables for the process; of the gateway's own environment only `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `SystemRoot` and `TEMP` are passed on |
| `cwd` | stdio | Working directory for the process |
| `timeout` | Both | Request timeout in ms; default `10000` |
| `enabled` | Both | Connect and expose the backend; default `true` |
| `trafficLimit` | Both | Requests per second to the backend (integer), including catalog fetches and health probes; default `1` |
| `enabledTools` | Both | Tools exposed to clients; if omitted, every tool from the first fetch is exposed |
| `availableTools` | Both | Discovered tools; managed by the gateway, do not edit |

After the first fetch, newly discovered tools stay hidden until enabled. Tools
that disappear from a backend are removed from both tool lists. An unknown name
in `enabledTools` makes the backend unavailable until corrected or until any
tool is toggled in the dashboard.

### Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4567` | Listening port |
| `MCP_MAX_SESSIONS_PER_CLIENT` | `10` | Retained 2025 sessions per client name/version; the oldest is dropped beyond it |

Start from `.env.example` when creating `.env`.

## Run the gateway

### Local

```bash
bun dev     # hot reload
bun start   # normal run
```

Bun runs the TypeScript source directly; there is no build step.

### Docker

```bash
docker compose up --build
```

Compose passes `.env` to the container and mounts `mcp.json` (configuration and
tool state) and `db/` (traffic log), both read-write. To run the image manually:

```bash
docker build -t aawa-mcpx .
docker run -p 4567:4567 -v $(pwd)/mcp.json:/home/app/mcp.json:rw -v $(pwd)/db:/home/app/db aawa-mcpx
```

### Apple container CLI

```bash
container build -t local/aawa-mcpx:latest .
container create --env-file=.env --user=1000:1000 --publish=4567:4567 --volume=./mcp.json:/home/app/mcp.json --volume=./db:/home/app/db --name aawa-mcpx local/aawa-mcpx:latest
container start aawa-mcpx
```

## Use the gateway

Point your MCP client to `http://localhost:<PORT>/mcp`:

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

Tools and prompts appear as `serverName__itemName`. Resources appear as
`aawa-mcpx://resource/<namespace>/<encoded-original-uri>`, and resource templates
as `aawa-mcpx://template/<namespace>/<original-template>`. Names that would be
ambiguous are escaped; see [namespaces](/DESIGN.md#38-namespaces-and-resource-routing).

## Dashboard

Open `http://localhost:<PORT>/`. The summary at the top lists backends with
their status and **Enable**/**Disable** buttons, plus a **Refresh** for all
backends. Refresh re-fetches catalogs and, for `2026-07-28` backends, server
info, capabilities, and instructions. Below it are three tabs:

- **Backends** (default view): each backend's tools, prompts, and resources, a per-backend **Refresh**, and **Expose to clients** toggles for tools.
- **Client**: clients grouped by reported name and version, with first and last activity and latest protocol.
- **Tester**: call an exposed tool through a form generated from its input schema.

The separate **Debug** page (`/debug`) shows client and backend traffic from the current run, with filters.

## Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP) |
| `/mcp` | DELETE | Terminate a 2025 MCP session |
| `/` | GET | Dashboard |
| `/debug` | GET | Debug page |
| `/api/overview` | GET | Dashboard snapshot |
| `/api/events` | GET | SSE stream of dashboard updates |
| `/api/backends/toggle` | POST | Enable or disable a backend (`{ serverName, enabled }`) |
| `/api/backends/refresh` | POST | Refresh catalogs (`{ serverName }` for one backend, `{}` for all) |
| `/api/tools/toggle` | POST | Show or hide a tool for clients (`{ name, enabled }`, `name` in public `serverName__toolName` form) |
| `/api/tools/call` | POST | Call an exposed backend tool (`{ serverName, toolName, arguments? }`) |
| `/api/health` | GET | Per-backend connectivity |
| `/api/debug` | GET | First page of client traffic and of each backend's traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/client` | GET | Client traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/backend` | GET | One backend's traffic (`?backend=&method=&limit=&offset=&errorsOnly=`; `backend` required) |

Toggles persist to `mcp.json`. Traffic is stored in `db/traffic.db`, which keeps the newest 10,000 records and is cleared at startup. Any other path serves the dashboard page.

## Development

| Command | Description |
| --- | --- |
| `bun test` | Run tests |
| `bun lint` | Type check, then run Biome with automatic fixes |
| `./scripts/checksum` | SHA-256 checksum of the Docker build context; writes `checksum.txt` and `files.txt` (needs `rg`) |

[AGENTS.md](/AGENTS.md) has instructions for AI coding agents.

## License

Licensed under the Apache License 2.0. Copyright © 2026 Mikael Nakajima
([Aawa Technologies](https://aawa.jp)). See [LICENSE](/LICENSE) for the full
license text.
