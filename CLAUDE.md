# CLAUDE.md

This project is documented in [AGENTS.md](AGENTS.md) — read that first. It's
the canonical reference for architecture, invariants, and conventions, and
it applies to Claude Code exactly the same as any other agent. Keeping the
substantive content in one file (rather than two that inevitably drift) is
deliberate; don't fork guidance between the two.

## Claude Code-specific notes

- **This folder is a separate git repository**, currently living nested
  inside a consumer app (`icw-smart-chart/`) purely for local dogfooding.
  It is gitignored from that app's tree (see the parent repo's
  `.gitignore`) and has its own commit history — don't assume anything
  committed here is part of the enclosing repo, and don't assume anything
  committed in the enclosing repo touches this folder.
- **The enclosing app's own `CLAUDE.md`** (one directory up) governs *that*
  codebase's conventions — Next.js/React/tRPC/Lattice/Firestore, all of it.
  None of that applies inside `sidebranch/`. This is a standalone,
  zero-dependency Node tool with its own, much smaller rule set (see
  AGENTS.md). Don't reach for Lattice, Zod, React, or any of the consumer
  app's patterns in here — there is no build step and no framework;
  `src/assets/widget.js` and `src/assets/shell.html` are plain files served
  to a browser as-is.
- **`pnpm check`/`tsc`/`eslint` run from the consumer app's root exclude
  this folder** (`tsconfig.json` and `eslint.config.js` both list
  `sidebranch` in their ignore/exclude lists) — that's intentional, this
  tool has its own test runner (`node --test`) and no TypeScript. If you
  ever see this folder's files showing up in the consumer app's lint/type
  errors again, that exclusion regressed; fix the exclusion, not the code.
