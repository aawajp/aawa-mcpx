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
| `CHANGELOG.md` | Every user-visible change, per release. | Users upgrading |
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

- Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with every
  entry dated. Add every user-visible change in the same change as the code,
  under `## [Unreleased]`, then a `### YYYY-MM-DD` heading for the commit date
  (newest first; reuse the heading if it exists), then `#### Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, or `Security`.
- Write one entry per change from the user's point of view. Mark breaking
  changes with **Breaking:** and include upgrade steps. Skip internal
  refactors, test-only changes, and doc-only changes.
- On release, replace `[Unreleased]` with `[<version>] - <release date>`, keep
  the dated headings below it, add a new empty `[Unreleased]` above it, and
  match the `package.json` version.
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

## Scope control

- Keep changes scoped to the user request.
- Do not move files only for theoretical neatness; prefer names and structure
  that make ownership clearer.

## Commands

- Run `bun lint` after code changes.
- Do not run `npm`, `npx`, `yarn`, `pnpm`, `node`, or ad hoc TypeScript/Biome
  commands when a package script exists.
- Use `rg`, `fd`, `eza`, and `tre` for inspection.

## Editing conventions

- Use existing path aliases such as `@/...` for TypeScript and TSX imports.
- Keep HTML and CSS paths relative where alias imports are not supported.
- Prefer grouped exports at the bottom of modules when consistent with the file.
- Do not introduce `any`; use concrete types or `unknown`.
- Use ArkType by default. Reserve the existing Ajv peers for arbitrary provider
  JSON Schema, which ArkType cannot import.
- Compile input schemas on catalog fetch, reuse validators on calls, and avoid
  repeated validation of the same request or catalog data within that lifecycle.
- Keep public/exported function parameters and return types explicit.
- Tests never read or write local private files such as `.env`, `mcp.json`, or
  `db/`. Pass file paths explicitly and use temporary folders under the OS temp
  directory; never change the working directory.
- Use sentence case for markdown headings.

## Boundary checks

When changing protocol validation or negotiation, preserve the initial HTTP
discovery fallback for legacy backends that reject the probe with HTTP
`400`/`404`/`405` and an invalid RPC envelope (such as `id: null`). Use only the HTTP
status for this fallback; keep initialization, pinned peers, and application
responses strictly validated. Run the negotiation regressions in
`src/mcp_upstreams/protocol_client.test.ts` and the envelope regressions in
`src/mcp_upstreams/protocol_validation.test.ts`.

Before finishing structural or naming changes, check:

- `src/ui` does not import from `src/gateway`, `src/mcp_upstreams`,
  `src/server`, or `src/config`.
- Server-side modules do not import React UI implementation modules.
- Shared code remains safe for both browser and server runtimes.
- File and directory names are current in `README.md`, `DESIGN.md`,
  `AGENTS.md`, and config files.
- `CHANGELOG.md` has an entry for every user-visible change.

Useful checks:

```bash
rg "@/gateway|@/mcp_upstreams|@/server|@/config" src/ui
bun lint
```
