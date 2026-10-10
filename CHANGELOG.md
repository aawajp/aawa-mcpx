# Changelog

All notable changes to aawa-mcpx are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with every
entry under the date its change was committed. The project uses
[Semantic Versioning](https://semver.org/); no version has been released yet.

## [Unreleased]

### 2026-10-10

#### Added

- Tool input schemas are validated when catalogs are fetched, and call
  arguments are validated once per call. Tools with unusable input schemas are
  hidden from MCP catalogs and their calls are blocked. Arguments that fail the
  schema return `-32602` to `2025-06-18` clients and an `isError` result to
  `2025-11-25` and `2026-07-28` clients.
- Provider output schemas appear in catalogs and the dashboard, and successful
  results are checked against them (warnings only). Missing `structuredContent`
  is recovered from JSON text content.
- **Refresh** buttons in the dashboard and `POST /api/backends/refresh` fetch
  fresh catalogs for one or all backends.
- `_meta` on `tools/call`, `prompts/get`, and `resources/read`, including trace
  context, is forwarded to backends.
- Cancellation reaches backends: `notifications/cancelled` from 2025 clients and
  disconnects from `2026-07-28` clients cancel the backend request.

#### Changed

- **Breaking:** resource URIs are now
  `aawa-mcpx://resource/<namespace>/<encoded-original-uri>`. Rediscover catalogs
  after upgrading; `serverName://original-uri` references still route. Backend
  names that would be ambiguous in tool and prompt names are escaped with a
  `mcpx-` prefix.
- For 2025 clients, output schemas that permit non-object values are wrapped in
  a `value` property to match the wrapped results; `2026-07-28` clients receive
  any JSON value. Text content that only repeats the structured value is removed.
- Tool-call errors use the JSON-RPC codes and HTTP statuses of the client's revision.
- `2026-07-28` requests must carry valid request metadata and matching HTTP
  header mirrors, including `x-mcp-header` parameters. Each backend request
  rebuilds its own headers.
- Tools that disappear from a backend are removed from `availableTools` and
  `enabledTools` in `mcp.json`, also after a restart.
- `ajv` 8.20.0 and `ajv-formats` 3.0.1 are new peer dependencies;
  `@modelcontextprotocol/sdk` updated to 1.32.1.

#### Fixed

- Malformed JSON-RPC envelopes and tool results from backends are rejected
  instead of being forwarded.
- Legacy HTTP backends that reject discovery with HTTP `400`/`404`/`405` and an
  invalid error envelope can still initialize.
- The Debug page's backend tab loads traffic for the backend its selector
  shows. Before, some backend names (for example, ones differing in letter case)
  left it empty until **Refresh** was pressed.

### 2026-10-09

#### Added

- Backends recover automatically from network interruptions, timeouts, HTTP
  `408`/`429`/`5xx`, and lost sessions, with jittered backoff from 5–10 s up to
  30–60 s. Health probes run after 60 s without traffic, and two failed probes
  mark a backend down. Failed tool calls are not replayed.

#### Changed

- Dependency updates, including `@modelcontextprotocol/sdk` 1.32.0 and ArkType 2.2.7.

### 2026-09-28

#### Changed

- Dependency updates, including `@modelcontextprotocol/sdk` 1.30.1, React 19.3.0,
  and ArkType 2.2.5.
- `bun install` skips package versions published less than four days ago.

### 2026-09-06

#### Added

- MCP `2026-07-28` for clients and backends, with per-request metadata,
  discovery, HTTP header mirrors, and cache hints. Each backend selects the
  highest revision both sides support and keeps it until restart.
- Non-object `structuredContent` is wrapped as `{ "value": ... }` for 2025 clients.
- `MCP_MAX_SESSIONS_PER_CLIENT` (default `10`) limits retained sessions per
  client name and version; the oldest is dropped beyond it.
- The dashboard groups clients by reported name and version with first and last
  activity and protocol, shows each backend's selected protocol, and splits the
  Debug page into client and backend traffic tabs.

#### Changed

- Protocol negotiation failures stop automatic reconnects and are shown on the
  dashboard with the failed method, revision, and error codes.
- Backend connections use the gateway's own protocol client; the MCP SDK
  provides types only.
- Container image updated from Bun 1.4.0 to 1.4.2, with dependency updates.

#### Removed

- MCP `2025-03-26`.
- `MCP_SESSION_TTL_MS` and `MCP_SESSION_SWEEP_INTERVAL_MS`: sessions no longer
  expire on a timer.

### 2026-08-24

#### Added

- MCP gateway that aggregates tools, prompts, and resources from Streamable HTTP
  (JSON or SSE) and stdio backends behind one endpoint, for clients on MCP
  `2025-11-25`, `2025-06-18`, and `2025-03-26`.
- Namespaced names (`serverName__itemName`) and resource URIs
  (`serverName://original-uri`).
- `mcp.json` configuration with per-backend `timeout`, `enabled`,
  `trafficLimit`, and `enabledTools`; exposure changes are saved to it.
- Session expiry through `MCP_SESSION_TTL_MS` and `MCP_SESSION_SWEEP_INTERVAL_MS`.
- Dashboard with backends, clients, a tool tester, and a traffic debug page,
  backed by `/api/*` endpoints with live updates.
- SQLite traffic log, cleared at startup.
- Container image, `compose.yaml`, and Apple container instructions.
