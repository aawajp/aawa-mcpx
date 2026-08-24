# Agent instructions

These instructions are for AI agents working in **aawa-mcpx**. Keep this file
focused on agent workflow. Do not duplicate usage documentation from
`README.md` or architecture documentation from `DESIGN.md`.

## Information lookup

Use the docs in this order:

1. `README.md` for user-facing setup, configuration, runtime settings,
   endpoints, and operational usage.
2. `DESIGN.md` for architecture, source layout, runtime boundaries, terminology,
   and protocol design.
3. Source files for implementation details and current behavior.
4. `package.json`, `biome.jsonc`, `tsconfig.json`, `Dockerfile`, and
   `compose.yaml` for tooling and container runtime details.

When code and docs disagree, trust the code for current behavior, then update
the relevant doc as part of the change.

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
- Keep public/exported function parameters and return types explicit.
- Use sentence case for markdown headings.

## Boundary checks

Before finishing structural or naming changes, check:

- `src/ui` does not import from `src/gateway`, `src/mcp_upstreams`,
  `src/server`, or `src/config`.
- Server-side modules do not import React UI implementation modules.
- Shared code remains safe for both browser and server runtimes.
- File and directory names are current in `README.md`, `DESIGN.md`,
  `AGENTS.md`, and config files.

Useful checks:

```bash
rg "@/gateway|@/mcp_upstreams|@/server|@/config" src/ui
bun lint
```
