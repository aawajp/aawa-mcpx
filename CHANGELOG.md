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
- `@modelcontextprotocol/sdk` is a dev dependency, since the gateway uses only
  its types. The Tailwind packages and `tailwind-merge` are runtime
  dependencies, since the server bundles the dashboard at startup.
- Bun no longer loads `.env` automatically; `bun dev` and `bun start` load it
  explicitly. Running `bun src/index.ts` directly ignores `.env`.
- Merged tool, prompt, and resource lists follow the backend order in
  `mcp.json`. Before, they followed the order in which backend catalogs arrived.

#### Removed

- Unused dependencies `hono`, `qs`, `lucide-react`, `@radix-ui/react-label`, and
  `@radix-ui/react-select`.

#### Fixed

- Malformed JSON-RPC envelopes and tool results from backends are rejected
  instead of being forwarded.
- Legacy HTTP backends that reject discovery with HTTP `400`/`404`/`405` and an
  invalid error envelope can still initialize.
- The Debug page's backend tab loads traffic for the backend its selector
  shows. Before, some backend names (for example, ones differing in letter case)
  left it empty until **Refresh** was pressed.
- Failed `tools/list` fetches appear in the Debug page's backend traffic, like
  failed prompt and resource fetches.
- Backends are asked only for the tool, prompt, and resource lists they
  advertise, as the MCP lifecycle requires. Before, every backend got all three
  requests, and a missing list made a `2026-07-28` backend's catalog refresh on
  every client request.
- `2026-07-28` backend lists are cached one by one. A client request re-fetches
  only the stale list it reads, and a tool call only its target backend's tools,
  so a slow backend no longer delays calls to other backends. A failed re-fetch
  keeps the previous list instead of emptying it.
- Backend resource templates appear in `resources/templates/list` as
  `aawa-mcpx://template/<namespace>/<original-template>`, and URIs expanded from
  them are read from that backend. Before, the list was always empty.
- Backend `ping` requests are answered, and other backend requests get
  `-32601`. A backend request whose ID matched a pending gateway call no longer
  completes that call.
- Stdio backends that ignore `SIGTERM` no longer hang disabling, reconnecting, or
  shutting down: the gateway closes stdin, then sends `SIGTERM`, then `SIGKILL`.
- A stdio backend that prints a non-JSON line to stdout keeps its connection;
  the line is logged and skipped. Backend stderr is logged instead of discarded,
  and a long stderr line no longer fails pending calls.
- Closing a 2025 HTTP backend ends its session with `DELETE`.
- A backend whose discovery result lists only 2025 revisions is initialized with
  the highest of them instead of failing.
- Backend SSE streams with bare CR line endings are read correctly.
- Requests the gateway rejects at the HTTP level (invalid `Origin`, unacceptable
  `Accept`, missing or unknown session, protocol version header errors) return
  JSON-RPC `-32600` with the same HTTP status. Before, the HTTP status
  (`400`/`403`/`404`) was used as the JSON-RPC code.
- Transport failures and malformed results from `prompts/get` and
  `resources/read` return a JSON-RPC `-32603` error, like `tools/call`, so 2025
  clients get HTTP `200` instead of `500`. Prompt messages and resource contents
  are validated; before, a malformed one (for example `null`) crashed the request.
- An unknown `MCP-Protocol-Version` header without request metadata returns HTTP
  `400` with "Unsupported MCP protocol version header". Before, any value sorting
  after `2025-11-25` (for example `zzz`) was handled as `2026-07-28`.
- 2025 clients can list tools whose output schema has a root `$ref` (as
  zod-to-json-schema emits). Before, the wrapped schema crashed Ajv, so clients
  such as the TypeScript SDK failed the whole `tools/list`.
- Resources whose URIs contain spaces or non-ASCII characters can be read. Before,
  they were listed but every read was rejected as an invalid URI.
- Structured content is recovered from JSON text only for tools with an output
  schema. Before, any JSON-looking text from a schema-free tool (for example
  `"42"`) was moved out of `content`.
- The gateway reports its `package.json` version in `serverInfo` and toward
  backends in `clientInfo`. Before, it always reported `1.0.0`.
- A backend disabled and re-enabled while a catalog refresh waited for its
  rate-limit slot loads its catalog again. Before, the new connection reused the
  old refresh and stayed with an empty catalog until the next manual refresh.
- Catalog fetches compile tool schemas much faster (200 schemas: about 0.2 s
  instead of 5 s). Before, every schema created its own Ajv instance, which
  blocked other requests while a large catalog loaded.
- `mcp.json` is written only when tool exposure or the enabled setting changes,
  and keeps its own content: only `enabled`, `enabledTools`, and
  `availableTools` change. Before, it was rewritten after every tool fetch with
  defaults such as `timeout` and `trafficLimit` added.
- A tool with invalid `x-mcp-header` annotations on a `2026-07-28` HTTP backend
  keeps its place in `enabledTools`. Before, it was dropped from the backend's
  catalog, pruned from `enabledTools`, and stayed off after the backend fixed
  the annotation.
- `trafficLimit` spaces requests that arrive together. Before, concurrent
  requests waited once and were sent at the same moment.
- A timeout or HTTP `408`/`429`/`5xx` on one backend request fails only that
  request. Before, it closed the backend connection, aborted other clients'
  requests, and kept the backend down for at least 5 seconds.
- A backend that answers its handshake with HTTP `401` or `403` keeps retrying
  with backoff, and the dashboard shows "Authentication failed". Before, it was
  reported as a protocol negotiation failure and retries stopped until the
  backend was disabled and re-enabled.
- A backend request that times out fails with "Backend request timed out after
  N ms" in errors and logs. Before, it read "The operation was aborted", the
  same as a cancelled request.
- A failed traffic log write (for example a full disk or a locked database) is
  printed to the console, and the client gets the real result. Before, the
  client got an internal error even when the call had succeeded.
- Tool results with `isError: true` are logged as errors, so the Debug page's
  **Errors only** filter shows them.
- **Refresh** in the dashboard updates a `2026-07-28` backend's server info,
  capabilities, and instructions, not only its catalogs. Before, they stayed as
  they were at connect time.

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
