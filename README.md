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
> The gateway has no client authentication and listens on all interfaces. It
> refuses requests whose host or `Origin` is not listed in `ALLOWED_HOSTS`,
> which stops web pages in your browser from calling it, but any client on the
> network can still send an allowed host. Run it only on a trusted network.

## Prerequisites

- Bun 1.4 or newer
- `mcp.json` in the project root with backend definitions

## Install

```bash
bun install
```

## Configuration

The gateway takes its settings from environment variables and from `mcp.json`;
it has no command-line options. Both are validated at startup, and an invalid
or unknown setting stops the gateway with an error that names it.

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

| Field | Transport | Type | Description |
| --- | --- | --- | --- |
| `type` | Both | `"http"` or `"stdio"` | Transport (required) |
| `url` | HTTP | `http://` or `https://` URL | Backend MCP endpoint (required) |
| `headers` | HTTP | Object of strings | Literal header values sent to the backend |
| `command` | stdio | Non-empty string | Server executable (required) |
| `args` | stdio | Array of strings | Command-line arguments |
| `env` | stdio | Object of strings | Literal environment variables for the process; of the gateway's own environment only `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `SystemRoot` and `TEMP` are passed on |
| `cwd` | stdio | String | Working directory for the process |
| `timeout` | Both | Positive integer | Request timeout in ms; default `10000` |
| `enabled` | Both | Boolean | Keep the backend connected and expose it; default `true`. A disabled backend is contacted once at startup and on its **Refresh** so the dashboard can show its details |
| `trafficLimit` | Both | Positive integer | Requests per second to the backend, including catalog fetches and health probes; default `1` |
| `enabledTools` | Both | Array of strings | Tools exposed to clients; if omitted, every tool from the first fetch is exposed |
| `availableTools` | Both | Array of strings | Discovered tools; managed by the gateway, do not edit |

Other fields, in a backend or next to `mcpServers`, are refused.

After the first fetch, newly discovered tools stay hidden until enabled. Tools
that disappear from a backend are removed from both tool lists. An unknown name
in `enabledTools` makes the backend unavailable until corrected or until any
tool is toggled in the dashboard.

### Environment

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `PORT` | Integer from 1 to 65535 | `4567` | Listening port |
| `ALLOWED_HOSTS` | Comma-separated host names | required | Host names clients and the dashboard use, such as `localhost,127.0.0.1,[::1]`; other hosts get HTTP 403 |
| `MCP_MAX_SESSIONS_PER_CLIENT` | Positive integer | `10` | Retained 2025 sessions per client name/version; the oldest is dropped beyond it |
| `NODE_ENV` | String | unset | `production` turns off the dashboard's hot reload and browser console forwarding |

`bun start` and `bun dev` read these from `.env`, and Docker Compose passes
`.env` to the container. Start from `.env.example` when creating `.env`.

## Run the gateway

### Local

```bash
bun dev     # hot reload
bun start   # normal run
```

Bun runs the TypeScript source directly.

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
their enabled and total tool counts, status, **Enable**/**Disable**, and
**Refresh** buttons, plus
**Refresh all**. Clicking a backend name opens its card in the Backends tab. Refreshing re-fetches catalogs and, for `2026-07-28` backends,
server info, capabilities, and instructions; a disconnected enabled backend reconnects. Below it are three tabs:

- **Backends** (default view): each backend's prompts, resources, and tools, a per-backend **Refresh**, and **Expose to clients** toggles for tools. A disabled backend shows what it last reported; its **Refresh** contacts it once and leaves it disabled.
- **Client**: clients grouped by reported name and version, with first and last activity and latest protocol.
- **Tester**: call an exposed tool through a form generated from its input schema. Object, array, `anyOf`, and untyped arguments are entered as JSON.

Backend URLs are shown with query values replaced by `***`, so API keys stay
hidden while the parameter names remain visible.

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
| `/api/tools/toggle` | POST | Show or hide a tool for clients (`{ serverName, toolName, enabled }`) |
| `/api/tools/call` | POST | Call an exposed backend tool (`{ serverName, toolName, arguments? }`) |
| `/api/health` | GET | Per-backend connectivity |
| `/api/debug` | GET | First page of client traffic and of each backend's traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/client` | GET | Client traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/backend` | GET | One backend's traffic (`?backend=&method=&limit=&offset=&errorsOnly=`; `backend` required) |

The debug queries take `limit` (positive integer, default `20`), `offset`
(integer from 0, default `0`) and `errorsOnly` (`1` or `0`, default `0`);
`/api/debug/backend` also takes `backend` (required) and `method`, both
non-empty. Request bodies and queries with other fields are refused.

Failed `/api/*` requests return `{ error }` with status 400 for a malformed request or a refused tool call, 403 for a host or `Origin` not in `ALLOWED_HOSTS`, 404 for an unknown backend or tool, and 500 otherwise. Toggles persist to `mcp.json`. Traffic is stored in `db/traffic.db`, which keeps the newest 10,000 records and is cleared at startup. Any other path serves the dashboard page.

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
