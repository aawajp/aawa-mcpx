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
- Dashboard login for a superadmin and, optionally, admins at an OpenID Connect identity provider.
- Per-user and per-role permissions for MCP clients, which sign in with API keys or OAuth access tokens.

Interactive features (sampling, elicitation, subscriptions, tasks) are not
supported. [DESIGN.md](/DESIGN.md) describes the architecture, protocol
behavior, and planned design; [CHANGELOG.md](/CHANGELOG.md) lists changes.

> [!WARNING]
> The gateway listens on all interfaces. It refuses requests whose host or
> `Origin` is not listed in `ALLOWED_HOSTS`, which stops web pages in your
> browser from calling it. With `ENABLE_SUPERADMIN=false` and
> `ENABLE_OIDC=false`, the dashboard and `/mcp` need no login or credentials
> at all; see [Authentication](#authentication).

## Prerequisites

- Bun 1.4 or newer
- `mcp.json` in the project root with backend definitions
- For the OIDC login (`ENABLE_OIDC=true`, optional): an OpenID Connect identity provider (IdP) with a confidential web client

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
| `cwd` | stdio | String | Working directory for the process; give a backend run with Bun its own, or Bun loads the gateway's env files, `.env.local` included |
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
| `MCP_MAX_SESSIONS_PER_CLIENT` | Positive integer | `10` | Retained 2025 sessions per user and client name/version; the oldest is dropped beyond it |
| `MCP_MAX_SESSIONS_PER_USER` | Positive integer | `100` | Retained 2025 sessions per user, of all clients; the user's oldest is dropped beyond it |
| `ENABLE_SUPERADMIN` | `true` or `false` | `true` | Superadmin login for the dashboard; the `SUPERADMIN_*` settings are used only when `true` |
| `SUPERADMIN_USERNAME` | String | required with the superadmin | Superadmin's username, also its Name and Username in the Auth tab |
| `SUPERADMIN_PASSWORD_HASH` | `Bun.password` hash | required with the superadmin | Hash of the superadmin's password, with each `$` written as `\$`; see [Authentication](#authentication) |
| `ENABLE_OIDC` | `true` or `false` | `false` | OIDC login for the dashboard and OAuth access tokens and OIDC machines' API keys on `/mcp`; the `OIDC_*` settings and `ADMIN_ROLES` are used only when `true` |
| `OIDC_ISSUER` | URL | required with OIDC | IdP issuer, discovered at startup; `https` unless the host is `localhost`, `127.0.0.1` or `[::1]` |
| `OIDC_CLIENT_ID` | String | required with OIDC | Dashboard client ID at the IdP |
| `OIDC_CLIENT_SECRET` | String | required with OIDC | Dashboard client secret, sent with HTTP Basic authentication (`client_secret_basic`) |
| `OIDC_AUDIENCE` | String | required with OIDC | Audience (`aud`) that OAuth access tokens on `/mcp` must name |
| `OIDC_SCOPES` | Comma-separated scopes | `openid,profile,offline_access` | Scopes the dashboard login, MCP clients and OIDC machines' API keys request, including any the IdP needs to put roles in tokens |
| `OIDC_ROLES_CLAIM` | String | required with OIDC | Token claim with the user's roles: a list of role names or an object keyed by role |
| `ADMIN_ROLES` | Comma-separated roles | required with OIDC | Roles whose OIDC users may log in to the dashboard |
| `PUBLIC_URL` | Origin URL | required with a login method | Origin the browser uses for the dashboard, such as `https://mcpx.example.com`; `https` unless the host is `localhost`, `127.0.0.1` or `[::1]` |
| `UI_SESSION_MAX_AGE` | Positive integer (seconds) | `28800` | Dashboard session lifetime from the login |
| `UI_SESSION_IDLE_TIMEOUT` | Positive integer (seconds) | `3600` | Dashboard session lifetime from its last use |
| `NODE_ENV` | String | `development` with `bun run dev`, `production` in `compose.yaml` | `development` turns on the dashboard's hot reload and browser console forwarding; not set in `.env`, as Bun picks `.env.<NODE_ENV>` from the process environment |

The committed `.env` lists every setting with its default, except `NODE_ENV`. Keep secrets and
local values in `.env.local`, which git ignores; Bun loads it after `.env`, so
its values win, both for `bun dev` and in the container (but not for
`bun test`). The image contains `.env`; mount `.env.local` into `/home/app`.

### Authentication

`ENABLE_SUPERADMIN` and `ENABLE_OIDC` turn on the login methods. With either
on, the dashboard needs a login and every `/mcp` request needs credentials:

| `ENABLE_SUPERADMIN` | `ENABLE_OIDC` | Dashboard login | `/mcp` credentials |
| --- | --- | --- | --- |
| `true` (default) | `false` (default) | Superadmin's username and password | Local machines' API keys |
| `true` | `true` | Username and password, or OIDC | Local and OIDC machines' API keys, OAuth access tokens |
| `false` | `true` | OIDC | OIDC machines' API keys, OAuth access tokens |
| `false` | `false` | None | None; every enabled tool is available |

Turning both off is highly discouraged, as the dashboard and `/mcp` are then
unprotected. It suits only setups that protect the gateway themselves, such as
a reverse proxy with basic auth.

**Internet exposure.** When the gateway is reachable from the internet, using
OIDC with `ENABLE_SUPERADMIN=false` is highly recommended. Client address
restrictions and rate limits belong in the layers in front of it, such as a
reverse proxy or network policy: the password login's failure limit counts per
connecting address, so behind a proxy all clients share it.

**Superadmin.** Set `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD_HASH` in
`.env.local`. This command prompts for the password and prints its hash
(argon2id), with each `$` written as `\$`, since env files expand `$` even in
quotes:

```bash
bun -e 'console.log((await Bun.password.hash(prompt("Password:"))).replaceAll("$", "\x5c$"))'
```

After 5 failed logins from one connecting address, logins from it are refused until 15
minutes after the first of them. The superadmin is a Local human in the Auth tab, added at the first
start and renamed when `SUPERADMIN_USERNAME` changes; its Name and Username
both equal `SUPERADMIN_USERNAME`. It cannot be deleted, disabled or renamed in
the Auth tab, but its roles can be changed. It has no API keys; the Tester
calls `/mcp` as the superadmin, with its permissions. With `ENABLE_SUPERADMIN=false` the user stays but
cannot log in.

**OIDC.** Register the dashboard app at the IdP with the authorization code
flow and PKCE, the redirect URI `<PUBLIC_URL>/api/auth/callback`, the
post-logout redirect URI `<PUBLIC_URL>/ui`, and roles in the ID token. Only
users with a role in `ADMIN_ROLES` get into the dashboard. MCP clients find
the IdP through the protected resource metadata (RFC 9728) and send its access
tokens: JWTs from `OIDC_ISSUER` for `OIDC_AUDIENCE`, with roles in
`OIDC_ROLES_CLAIM`.

**Users.** The Auth tab lists the users MCP clients sign in as. A user's realm
(where it comes from) and type are chosen when it is added and never change.
A human signs in itself, and its MCP client then calls `/mcp` for it; a
machine, such as a service account, uses API keys:

| Realm | Type | User ID | Signs in to `/mcp` with |
| --- | --- | --- | --- |
| Local | Human | Generated | Nothing; only the superadmin, for the dashboard |
| Local | Machine | Generated; a Name is required | API keys made by the gateway |
| OIDC | Human | The IdP user ID (`sub`) | OAuth access tokens |
| OIDC | Machine | The IdP user ID (`sub`) | API keys built from its client ID and a client secret from the IdP |

A token for an unknown user adds it as an OIDC human, with no permissions, and
unknown roles in the token are added too. Each token updates the user's roles: roles it names
are assigned and roles it drops are unassigned; roles assigned only in the
dashboard stay. A role a token names follows the IdP from then on: once a later
token drops it, it is unassigned, even if it was also assigned in the dashboard.
In the Users and Roles cards, **Save** on the title line saves every changed
row, the new one in the last row included.

**Permissions.** A user's permissions are its own plus those of its roles. The
backend permission covers a backend's prompts, resources and resource
templates; each tool needs its own permission. Lists show only what the user
may use; a call without permission gets HTTP 403. **Permit all tools** and
**Revoke all tools** check or clear every tool of the chosen user or role
(roles' permissions stay), and **Permit all** and **Revoke all** in a backend's
row do the same for its tools; **Save** applies them.

**API keys.** **New API key** in a machine's row adds a key; machines can have
several. A Local key (`sk_aawa_local01_…`) is made by the gateway. An OIDC
machine's key (`sk_aawa_api01_…`) is built in the browser from its service
account's client ID (prefilled from Username) and client secret, and only its
hash is sent; the gateway exchanges the key at the IdP with the client
credentials grant. Each key is shown once and stored as a hash, and only keys
listed in the API keys card sign in, so **Revoke** takes effect at once.
MCP clients send a key as `Authorization: Bearer <key>`.

An OIDC machine's key holds its service account's client secret, so the
gateway cannot tell when that secret is rotated at the IdP: after rotating it,
register the new key and revoke the old one. Some IdPs (for example ZITADEL)
keep one secret per service account, so the old key stops working at the IdP
once its cached token expires. Use a dedicated service account per key.

## Run the gateway

### Local

```bash
bun dev   # hot reload
```

Bun runs the TypeScript source directly.

### Exit codes

A startup failure logs one `Startup failed: …` line. The exit code tells a
supervisor whether restarting can help:

| Code | Recoverable | Cause |
| --- | --- | --- |
| `1` | No | Unexpected error |
| `75` | Yes | Temporary startup failure: the IdP cannot be reached, or the port is in use |
| `78` | No | Configuration error: invalid settings or `mcp.json`, or a main database newer than the gateway |

### Docker

```bash
docker compose up --build
```

Compose mounts `.env.local` read-only, and `mcp.json` (configuration and
tool state) and `db/` (main database and traffic log) read-write. It restarts
the gateway at most 3 times after a failure. To run the
image manually:

```bash
docker build -t aawa-mcpx .
docker run -p 4567:4567 -v $(pwd)/.env.local:/home/app/.env.local:ro -v $(pwd)/mcp.json:/home/app/mcp.json:rw -v $(pwd)/db:/home/app/db aawa-mcpx
```

### Apple container CLI

```bash
container build -t local/aawa-mcpx:latest .
container create --user=1000:1000 --publish=4567:4567 --volume=./.env.local:/home/app/.env.local --volume=./mcp.json:/home/app/mcp.json --volume=./db:/home/app/db --name aawa-mcpx local/aawa-mcpx:latest
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

Tools and prompts appear as `serverName__itemName`, and that name is also their
title (`title`, and a tool's `annotations.title`): clients that show titles,
such as Claude Code, then keep them grouped by backend. Resources appear as
`aawa-mcpx://resource/<namespace>/<encoded-original-uri>`, and resource templates
as `aawa-mcpx://template/<namespace>/<original-template>`. Names that would be
ambiguous are escaped; see [namespaces](/DESIGN.md#38-namespaces-and-resource-routing).

## Dashboard

Open `/ui` (`/` redirects there). With a login method on, open it at
`<PUBLIC_URL>/ui`; the login page offers the superadmin's username and
password and, with OIDC, **Log in with OIDC**. Your name and **Log out** are at
the top right. A
session ends after `UI_SESSION_MAX_AGE`, or `UI_SESSION_IDLE_TIMEOUT` without
use, and survives gateway restarts. The summary at the top lists backends with
their enabled and total tool counts, status, **Enable**/**Disable**, and
**Refresh** buttons, plus
**Refresh all**. Clicking a backend name opens its card in the Backends tab. Refreshing re-fetches catalogs and, for `2026-07-28` backends,
server info, capabilities, and instructions; a disconnected enabled backend reconnects. Below it are the tabs:

- **Backends** (default view): each backend's prompts, resources, and tools, a per-backend **Refresh**, and **Expose to clients** toggles for tools. Prompts and tools show the name clients call; an opened tool shows its full name in Claude Code (`mcp__<server>__…`, where `<server>` is the gateway's key in the client config), and the backend's own name, titles and description. A disabled backend shows what it last reported; its **Refresh** contacts it once and leaves it disabled.
- **Clients**: one row per MCP client (reported name and version), user and protocol, with first and last activity.
- **Tester**: send an MCP request to `/mcp` as the logged-in admin (the superadmin, or with the OIDC admin's access token) and see the full request and response.
- **Auth** (with a login method on): users, roles, API keys and permissions; see [Authentication](#authentication).

The tables in **Clients** and **Auth** sort by a column when you click its header.

Backend URLs are shown with query values replaced by `***`, so API keys stay
hidden while the parameter names remain visible.

The separate **Debug** page (`/ui/debug`) shows client and backend traffic from the current run, with filters. A request or response over 256 KiB shows only its size and start, and a client, method or protocol version over 256 characters only its start.

## Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/mcp` | POST | MCP JSON-RPC endpoint (Streamable HTTP) |
| `/mcp` | DELETE | Terminate a 2025 MCP session |
| `/` | GET | Redirect to `/ui` |
| `/ui` | GET | Dashboard |
| `/ui/debug` | GET | Debug page |
| `/ui/login` | GET | Login page |
| `/.well-known/oauth-protected-resource/mcp` | GET | With OIDC: protected resource metadata (RFC 9728), also at `/.well-known/oauth-protected-resource` |
| `/api/auth/methods` | GET | With a login method: login methods that are on (`{ oidc, password, publicUrl }`) |
| `/api/auth/password` | POST | With the superadmin: log in (`{ username, password, returnTo? }`) |
| `/api/auth/login` | GET | With OIDC: start the dashboard login (`?returnTo=` a dashboard page) |
| `/api/auth/callback` | GET | With OIDC: IdP redirect target that finishes the login |
| `/api/auth/logout` | POST | With a login method: end the session; returns `{ logoutUrl }` to open next |
| `/api/auth/session` | GET | With a login method: logged-in user (`{ name }`) |
| `/api/access` | GET | With a login method: users, roles, permissions and API keys |
| `/api/access/users/save`, `/api/access/users/delete` | POST | With a login method: add, change or delete a user |
| `/api/access/roles/save`, `/api/access/roles/delete` | POST | With a login method: add, change or delete a role |
| `/api/access/permissions/save` | POST | With a login method: replace a user's or role's permissions |
| `/api/access/keys/create`, `/api/access/keys/register`, `/api/access/keys/revoke` | POST | With a login method: add a Local key, register an OIDC machine's key hash, revoke a key |
| `/api/overview` | GET | Dashboard snapshot |
| `/api/events` | GET | SSE stream of dashboard updates |
| `/api/backends/toggle` | POST | Enable or disable a backend (`{ serverName, enabled }`) |
| `/api/backends/refresh` | POST | Refresh catalogs (`{ serverName }` for one backend, `{}` for all) |
| `/api/tools/toggle` | POST | Show or hide a tool for clients (`{ serverName, toolName, enabled }`) |
| `/api/tester/mcp` | POST | Send an MCP request to `/mcp` as the logged-in admin (`{ headers, body }`); returns both sides |
| `/api/health` | GET | Health check for containers, without a login: `{ "status": "ok" }` while the gateway serves |
| `/api/debug` | GET | First page of client traffic and of each backend's traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/client` | GET | Client traffic (`?limit=&offset=&errorsOnly=`) |
| `/api/debug/backend` | GET | One backend's traffic (`?backend=&method=&limit=&offset=&errorsOnly=`; `backend` required) |

The debug queries take `limit` (integer from 1 to 100, default `20`), `offset`
(integer from 0, default `0`) and `errorsOnly` (`1` or `0`, default `0`);
`/api/debug/backend` also takes `backend` (required) and `method`, both
non-empty. Request bodies and queries with other fields are refused.

With a login method on, every `/api/*` endpoint except `/api/health` and the
login steps needs a dashboard session, and `/mcp` answers 401 without valid
credentials, 403 for an unknown or disabled user, and 502 when the IdP request
for an OIDC machine's API key fails. Failed `/api/*` requests return `{ error }` with status 400 for a malformed request or unusable Auth tab input, 401 without a valid session or for a wrong username or password, 403 for a host or `Origin` not in `ALLOWED_HOSTS`, a non-GET request whose `Origin` is not `PUBLIC_URL`, or an OIDC login without an admin role or of a disabled user, 404 for an unknown route, backend, tool, user, role or API key, 409 for an Auth tab change that conflicts with a rule or existing data (such as deleting the superadmin), 429 after too many failed password logins, 502 when the login's token request to the IdP fails, and 500 otherwise. Request bodies over 8 MiB, on `/mcp` too, get HTTP 413 without a body; backend HTTP JSON bodies, stdio lines and SSE events are limited to 8 MiB too, counted in bytes, and a backend's paginated list to 32 MiB in all. Toggles persist to `mcp.json`. Traffic is stored in `db/traffic.db`, which keeps the newest 10,000 records of at most 512 MiB in all and is cleared at startup. `db/main.db` holds the gateway's own data and is kept across restarts.

A path not listed above gets HTTP 404 with `{ error }`; a listed path with another method gets HTTP 405 with `Allow`.

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
