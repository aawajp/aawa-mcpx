# Agent instructions

These instructions are for AI agents working in **aawa-mcpx**. Keep this file
focused on agent workflow; [Documentation](#documentation) says where everything
else belongs.

## Documentation

Each kind of information has one home. Do not repeat content across docs; link
to the owning doc instead.

| Doc | Purpose | Audience |
| --- | --- | --- |
| `README.md` | Project overview: what the gateway does, setup, configuration, running, connecting clients, dashboard, endpoints, development commands. | Users and operators |
| `DESIGN.md` | Current design (architecture, source layout, protocol behavior, validation, persistence) and planned design (section 7). | Contributors and agents |
| `CHANGELOG.md` | Every commit, per release. | Users and contributors |
| `AGENTS.md` | Agent workflow and conventions only. | Agents |

### README.md

- Keep it an overview. State what a user sees and configures (fields,
  defaults, environment variables, endpoints, commands) in short tables and
  lists, and link to `DESIGN.md` for how and why.
- Do not add protocol rules, error mappings, internal limits, or module names.

### DESIGN.md

- Sections 1–6 describe the current design only: how the code behaves now,
  including known deviations from the MCP spec. Do not keep history, "previously"
  notes, progress logs, or descriptions of removed behavior; git history and
  `CHANGELOG.md` hold those.
- Section 7 holds planned design: options under consideration, open decisions,
  and their status. Nothing there is approved unless it says so. When planned
  work is implemented, move its description into sections 1–6 and delete it
  from section 7.
- Update the section that owns a behavior in the same change as the code, and
  keep the source table in 2.1 current when files are added, moved, or removed.
- Put important rationale here, not in source comments. Source comments must
  not hold details that go stale, such as doc references or upstream versions.
- Use compact tables and sentence-case headings; link spec sections in
  section 8 or inline.

### CHANGELOG.md

- Follow the rules at the top of `CHANGELOG.md` when editing it.
- `CHANGELOG.md` is the only place that tracks changes; do not add change
  notes to other docs.

### Lookup order

1. `README.md` for user-facing behavior and operations.
2. `DESIGN.md` for architecture and protocol behavior.
3. Source files for implementation details.
4. `package.json`, `biome.jsonc`, `tsconfig.json`, `Dockerfile`, and
   `compose.yaml` for tooling and container details.

When code and docs disagree, trust the code for current behavior, then fix the
doc in the same change.

## Commands

- Run `bun lint` after code changes.
- Do not run `npm`, `npx`, `yarn`, `pnpm`, `node`, or ad hoc TypeScript/Biome
  commands when a package script exists.

## Editing conventions

- Import code through the `@/` alias, even from the same folder. Relative
  paths are only for non-code files such as JSON, CSS, and HTML; `bun lint`
  enforces this and the `src/ui` and `src/shared` import boundaries.
- Name protocol logic by mechanism, such as `requiresInitialization(version)`,
  never by era ("modern", "legacy") or a revision date. Source comments name
  the MCP revision that introduced a rule, such as "MCP 2026-07-28 removed
  sessions"; a revision never changes, so this does not go stale.
- Use ArkType by default. Reserve Ajv and ajv-formats for arbitrary provider
  JSON Schema, which ArkType cannot import.
- Compile input schemas on catalog fetch, reuse validators on calls, and avoid
  repeated validation of the same request or catalog data within that lifecycle.
- Tests never read or write local private files such as `.env`, `mcp.json`, or
  `db/`. Pass file paths explicitly and use temporary folders under the OS temp
  directory; never change the working directory.

## Boundary checks

When changing protocol validation or negotiation, preserve the initial HTTP
discovery fallback for 2025 backends that reject the probe with HTTP
`400`/`404`/`405` and an invalid RPC envelope (such as `id: null`). Use only the HTTP
status for this fallback; keep initialization, pinned peers, and application
responses strictly validated. Run the negotiation regressions in
`src/server/mcp_upstreams/protocol_client.test.ts` and the envelope
regressions in `src/server/mcp_upstreams/protocol_validation.test.ts`.

Before finishing structural or naming changes, check that file and directory
names are current in `README.md`, `DESIGN.md`, `AGENTS.md`, and config files.
