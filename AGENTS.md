# Agent notes

Instructions for AI agents working on **aawa-mcpx**.

## Architecture overview

- Bun-native MCP gateway using `Bun.serve` for HTTP
- Aggregates multiple backend MCP servers (Streamable HTTP) into single endpoint
- Namespaces tools/prompts/resources to prevent collisions
- SQLite persistence for traffic logs (`db/traffic.db`)
- React UI with real-time updates via SSE

### Key files

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | [`src/index.ts`](src/index.ts) | Loads config, initializes managers, starts server |
| HTTP server | [`src/gateway/server.ts`](src/gateway/server.ts) | `Bun.serve` with all routes |
| Backend manager | [`src/backend/manager.ts`](src/backend/manager.ts) | MCP client connections to backends |
| Traffic store | [`src/utils/trafficStore.ts`](src/utils/trafficStore.ts) | SQLite persistence |
| MCP constants | [`src/config/constants.ts`](src/config/constants.ts) | Shared protocol metadata |
| Config loader | [`src/config/loader.ts`](src/config/loader.ts) | Parses `mcp.json` |
| Namespace utils | [`src/gateway/namespace.ts`](src/gateway/namespace.ts) | Server prefix handling |
| React app | [`src/App.tsx`](src/App.tsx) | Main UI component |

## Bun conventions (critical)

### Use Bun APIs, not Node.js alternatives

| Use | Do not use |
|-----|------------|
| `bun <file>` | `node`, `ts-node` |
| `bun test` | `jest`, `vitest` |
| `bun install` | `npm`, `yarn`, `pnpm` |
| `Bun.serve()` | Express, Koa, Fastify |
| `bun:sqlite` | `better-sqlite3`, etc. |
| `Bun.file()` | `fs.readFile`/`fs.writeFile` |
| (nothing) | `dotenv` (Bun auto-loads `.env`) |

### HTTP server pattern

Use `Bun.serve` with routes object. See [`src/gateway/server.ts`](src/gateway/server.ts) for the pattern:

```ts
Bun.serve({
  port,
  routes: {
    '/api': {
      async GET(request) { return Response.json({ ok: true }); },
      async POST(request) { /* ... */ }
    },
    '/*': indexHtml  // HTML import for frontend
  }
});
```

### Frontend bundling

Bun bundles frontend directly from HTML imports—no Vite/webpack:

- [`src/index.html`](src/index.html) imports [`src/frontend.tsx`](src/frontend.tsx) via `<script type="module">`
- CSS imports in TSX work natively
- HMR via `import.meta.hot` when running `bun --hot`
- Use `StrictMode` + `createRoot` from `react-dom/client`

### UI components and styling

This project uses [shadcn/ui](https://ui.shadcn.com/) for UI components and Tailwind CSS for styling.

**Priority order for UI implementation:**
1. **shadcn components** — Always prefer shadcn components first. See [component list](https://ui.shadcn.com/docs/components).
2. **Tailwind CSS** — Use Tailwind utility classes when shadcn alone is not sufficient.
3. **Additional libraries** — If still not sufficient, it is allowed to use additional libraries such as Radix UI primitives.
4. **Imports** — Use `@/...` aliases for TS/JS files; keep explicit imports for built-ins (e.g., `node:timers/promises`). HTML/CSS must remain relative (no alias support there).
5. **Text externalization** — Any user-facing strings must live in `src/i18n/strings.json` and be referenced via `t()`.

### SQLite

Use `bun:sqlite` with WAL mode. See [`src/utils/trafficStore.ts`](src/utils/trafficStore.ts):

```ts
import { Database } from 'bun:sqlite';
const db = new Database('db/traffic.db');
db.exec('PRAGMA journal_mode = WAL;');
```

### Testing

```ts
import { test, expect } from 'bun:test';
test('example', () => expect(1).toBe(1));
```

Run with `bun test`.

### Linting and type checking

This project does **not** use ESLint. Linting is handled by [Biome](https://biomejs.dev/) and type checking by `tsc`.

**Always run `bun lint` after making code changes.** This runs both `tsc` and `biome check --fix`. Do not invoke `tsc`, `bunx`, or other lint commands directly—only `bun lint`.

## MCP protocol

- Spec: https://modelcontextprotocol.io/specification/2025-06-18
- SDK: `@modelcontextprotocol/sdk`
- Transport: Streamable HTTP (uses `StreamableHTTPClientTransport`)
- Gateway advertises `protocolVersion` `2025-11-25` in `initialize` and UI responses.

### Namespacing rules

- Tools/Prompts: `{serverName}__{originalName}` (double underscore)
- Resources: `{serverName}://{originalUri}`

See [`src/gateway/namespace.ts`](src/gateway/namespace.ts) for implementation.

## Configuration

`mcp.json` follows Claude Code's MCP spec. Currently only `type: "http"` is supported; `type: "stdio"` is planned.

See README.md for configuration schema.

## Documentation style

When writing documentation:
- Use sentence case for headings (capitalize first word only, not every word)
- Example: "## Run the gateway" not "## Run The Gateway"

## Bun runtime references

- Bun native API overview: https://bun.com/docs/runtime/bun-apis.md
- HTTP/server: https://bun.sh/docs/api/http.md
- Routing: https://bun.com/docs/runtime/http/routing.md
- Cookies:
  - https://bun.com/docs/runtime/http/cookies.md
  - https://bun.com/docs/runtime/cookies.md
- SQLite: https://bun.sh/docs/api/sqlite.md
- DB queries (Bun SQL + SQLite): https://bun.com/docs/runtime/sql.md
- Fullstack/bundler: https://bun.sh/docs/bundler/fullstack.md
- Streams: https://bun.sh/docs/api/streams.md
- File I/O: https://bun.com/docs/runtime/file-io.md
- Fetch API: https://bun.com/docs/runtime/networking/fetch.md
- WebSockets: https://bun.com/docs/runtime/http/websockets.md
- TCP: https://bun.com/docs/runtime/networking/tcp.md
- UDP: https://bun.com/docs/runtime/networking/udp.md
- Env vars: https://bun.com/docs/runtime/environment-variables.md
- Bun native shell: https://bun.com/docs/runtime/shell.md
- Child processes: https://bun.com/docs/runtime/child-process.md
- Workers API: https://bun.com/docs/runtime/workers.md
