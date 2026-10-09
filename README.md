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

Backends are defined in `mcp.json` under `mcpServers`. The file is read once at startup; dashboard changes overwrite it from memory without merging external edits. Restart to load external changes.

### HTTP transport (streamable HTTP)

HTTP backends must expose Streamable HTTP with JSON or SSE `POST` responses. The optional standalone `GET` event stream is disabled; explicit requests and health checks refresh catalogs.

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

### Shared backend options

These optional fields apply to both transports:

| Field | Type | Behavior |
| --- | --- | --- |
| `timeout` | number | Request timeout in ms; default `10000` |
| `enabled` | boolean | Connect/start and expose the backend; default `true` |
| `trafficLimit` | number | Request spacing rate; default 1 request/s; concurrent calls are not serialized |
| `enabledTools` | string[] | Tools exposed to clients; initialized on first tool fetch if omitted |
| `availableTools` | string[] | Discovered tools; server-managed, not for manual edits |

Unknown names in `enabledTools` make the backend unavailable with an action-required configuration error until corrected.
Tools removed from a previously discovered catalog are pruned from both
`availableTools` and `enabledTools` in `mcp.json`, including after a reconnect or
restart. Newly discovered tools after the initial fetch remain unexposed until enabled.

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

Apple's `container` CLI runs the same image without a Docker-compatible runtime.

```bash
container build -t local/aawa-mcpx:latest .

container create --env-file=.env --user=1000:1000 --publish=4567:4567 --volume=./mcp.json:/home/app/mcp.json --volume=./db:/home/app/db --name aawa-mcpx local/aawa-mcpx:latest

container start aawa-mcpx
```

Create `.env` from `.env.example` first. Both configuration and database mounts are read-write.

The endpoint is `http://localhost:<PORT>/mcp`; `PORT` defaults to `4567`.

## Protocol behavior

Both client and backend connections support `2026-07-28`, `2025-11-25`, and `2025-06-18`. The newest revision uses per-request version/capability metadata and matching HTTP protocol, method, and applicable name headers. The 2025 revisions initialize sessions; unsupported initialization proposals receive `2025-11-25`. `2025-03-26` is not supported operationally.

Backend and client revisions are independent. Each backend selects the highest mutually supported revision on its first successful connection and retains it across reconnects and toggles until gateway restart. The 2025 backends initialize afresh on reconnect; `2026-07-28` backends use discovery for health checks. Stdio carries newline-delimited JSON-RPC.

For compatibility with legacy HTTP backends, an initial discovery rejection with
HTTP `400`/`404`/`405` can trigger initialization even if its RPC envelope is invalid
(for example, `id: null`). Only the HTTP status is used; initialization and
application responses still require valid envelopes and matching request IDs.
Dropping that status during envelope validation incorrectly stops negotiation
before a compatible 2025 backend can initialize.

Negotiation failures stop automatic retries. The UI shows the failed method, attempted revision, and available HTTP/JSON-RPC codes. Disable/re-enable to retry; restart to change a retained revision.

### Network recovery

Enabled backends automatically recover from network interruptions, timeouts,
HTTP `408`/`429`/`5xx`, and lost initialized HTTP sessions, including during handshakes.
Jittered retry delays are **5–10**, **10–20**, **20–40**, then **30–60 seconds**, measured
after each attempt finishes. Reconnection and catalog refresh reset the backoff;
concurrent reconnects share one attempt. Disable or shutdown cancels recovery.

Successful requests suppress probes for **60 seconds**. Idle probes run on the next
10-second tick, time out after at most 9 seconds (or the configured timeout if
shorter), and mark a backend down after two consecutive failures. Application
transport failures trigger recovery immediately. Probes target configured backends,
not separate internet-connectivity checks. Failed tool calls are never replayed
automatically because their side effects may have completed.

### Session management

The gateway issues session IDs for 2025 clients; unknown IDs return HTTP 404 and
require reinitialization. Sessions exist only in memory. The `2026-07-28` path
neither creates nor requires sessions.

`MCP_MAX_SESSIONS_PER_CLIENT` is a positive integer, default `10`; invalid values
use that default. Successful initialization beyond the limit removes the oldest
session for that name/version pair across both 2025 revisions, without affecting
other clients. Sessions have no timed expiry; DELETE removes one immediately.
Gateway restart clears sessions and client activity.

### Protocol feature scope

Tools, prompts, and resources work across supported revisions. Interactive
continuations, sampling, elicitation, subscriptions, and tasks are not advertised.
Backend catalog pages are fully materialized; stale `2026-07-28` catalogs refresh
on access with concurrent refresh deduplication. Backend credentials define their
authorization context. Public `2026-07-28` catalogs carry private, zero-TTL cache hints.
The gateway owns dispatch and transports; the SDK supplies types, not client/server implementations.

JSON-RPC envelopes require string/integer IDs, integer error codes, and matching response IDs. Backend
tool results require a `content` array with valid text, image, audio, resource-link,
or embedded-resource blocks, including Base64 data and optional metadata shapes.
Malformed results are rejected before normalization; extension fields are preserved.

Tool results remove only text blocks whose entire JSON value equals
`structuredContent`, ignoring formatting and object key order. Independent text,
JSON subsets or extra fields, images, audio, and resources remain. The required
`content` array may become `[]`. MCP responses and dashboard testing share this
policy; backend traffic retains the original result.

Omitting duplicate text deliberately departs from the spec's
[serialized-JSON `SHOULD` recommendation](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)
to avoid sending data twice. Structured output does not replace independent text
(see the [array-output example](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#output-schema)).
Empty-array compatibility still needs confirmation in each consuming application.

### Tool-call errors

Unknown/disabled tools or backends and invalid prefixed names return JSON-RPC
`-32602`. Disconnected backends, transport failures, malformed backend results,
and gateway dispatch failures return `-32603`. Backend execution errors retain
their `isError: true` result and feedback, following the
[tool error distinction](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling).
Input-schema mismatches follow the revision rules below.

Validated backend RPC errors retain message/data; codes adapt to the client
revision. For 2026, resource-not-found `-32002` becomes `-32602`, and retired or
unassigned reserved codes become `-32603`, per the
[error-code policy](https://modelcontextprotocol.io/specification/2026-07-28/basic#error-codes).
Modern metadata errors become `-32603` for 2025 clients; URL-elicitation `-32042`
is preserved only for [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-elicitation-required-error).

Ordinary 2025 RPC errors retain HTTP 200. The 2026 binding uses HTTP 400 for
invalid requests/parameters and metadata errors, 404 for unknown methods, and
500 for internal errors. HTTP handler failures use 500 in every revision;
backend HTTP statuses are not copied across independent protocol boundaries.

### Input schemas and arguments

Every supported revision requires `inputSchema.type: "object"`. Catalog fetches
validate and compile input schemas once; MCP calls and dashboard tests reuse those
validators for one argument-validation pass before backend work. Unusable schemas
hide only the affected tool from MCP catalogs and block its calls, with a warning.
Raw dashboard definitions and exposure settings remain available; refresh can
restore the tool after its schema is repaired.

Malformed call parameters return JSON-RPC `-32602` in every revision. Objects that
fail the tool's schema return `-32602` for
[2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling),
or `isError: true` for
[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)
and [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling).
The client revision controls this response independently of the backend revision.

### Output schemas

Provider `outputSchema` definitions appear in catalogs and the dashboard. Ajv and
`ajv-formats` (peer dependencies) validate successful results and compile input
schemas using JSON Schema 2020-12 by default, or declared draft-07/2019-09. ArkType
is the default for application shapes; Ajv handles arbitrary provider JSON Schema,
which ArkType cannot import.

Missing `structuredContent` is recovered from complete JSON text blocks up to
2 MiB each: use a single distinct value even if it mismatches the schema; with
multiple values, require a unique schema match or an array schema that validates
the ordered JSON items (including duplicates). Ambiguous/non-JSON content stays unchanged.
Advertised schemas cause warnings for missing or recovered structured output;
recovered results use the same duplicate-removal policy.

Mismatches, invalid schemas, unsupported dialects, and unresolved references log
warnings with backend/tool identifiers while returning results normally. This
deliberately tolerates violations of the spec's
[conforming-result `MUST` rule](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#output-schema);
an advertised schema therefore does not guarantee conformity. Validation never
coerces data, inserts defaults, or removes properties, and skips `isError: true`.
Input and output schemas share limits of 256 KiB, 10,000 visited values, and 64
nesting levels. Exceeding them blocks the affected input tool or warns for output.
External references are never fetched automatically, following
the [MCP JSON Schema requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic#json-schema-usage).

| Client revision | Structured output | Adaptation |
| --- | --- | --- |
| [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content), [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content) | JSON object | Wrap non-objects as `{ "value": ... }`; schemas permitting non-object output wrap both schema and result, including objects in unions |
| [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content) | Any JSON value | Preserve objects, arrays, strings, numbers, booleans, and `null` |

`false`, `0`, `""`, and `null` are present values. Object-only schemas and matching
objects stay unchanged across revisions; the dashboard retains provider shapes.
The SDK's object-only `CallToolResult` requires a wider gateway type, with client
restrictions applied at the response boundary.

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
| `/api/backends/refresh` | POST | Fetch fresh catalogs, then return the overview (`{ serverName }` for one backend; `{}` for all connected backends) |
| `/api/tools/toggle` | POST | Toggle client-visible tool state (`{ name, enabled }`) and persist to `mcp.json` |
| `/api/tools/call` | POST | Call a backend tool for UI testing (`{ serverName, toolName, arguments }`) |
| `/api/health` | GET | Health check with per-backend connectivity status |
| `/api/debug` | GET | Debug summary (client + all backend traffic) |
| `/api/debug/client` | GET | Paginated client traffic (`?limit=&offset=`) |
| `/api/debug/backend` | GET | Paginated backend traffic (`?backend=&method=&limit=&offset=`) |

Traffic is stored in `db/traffic.db` via Bun SQLite and is reset on gateway startup. The debug UI reads from this database.

Non-MCP APIs use `/api/*` to avoid UI route collisions.

## UI behavior

- **Backends** is the default view; **Tester** invokes tools without raw JSON. Backends and tools sort alphabetically.
- Backend **Refresh** fetches that backend's tools, prompts, and resources regardless of cache TTL or protocol revision. The summary **Refresh** fetches all connected backends; normal overview reads remain cached.
- Backend toggles persist `enabled`; `Expose to clients` controls tool exposure. Disabled backends retain exposure settings and show enabled tools as inactive.
- Descriptions and input/output schemas start folded. Protocol lists supported revisions; backend protocol and software versions are shown separately.
- Clients group by reported name/version, showing first/last seen and latest protocol. This bounded, in-memory history survives session closure, merges identically named instances, and exposes no session IDs or connection status.
- `/debug` has full-width **Client traffic** and **Backend traffic** tabs, an alphabetical backend selector, and persistent filters/pages across tabs. **Show all** is the default.

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
