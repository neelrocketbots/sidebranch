# CLAUDE.md

This project is documented in [AGENTS.md](AGENTS.md) — read that first. It's
the canonical reference for architecture, invariants, and conventions, and
it applies to Claude Code exactly the same as any other agent. Keeping the
substantive content in one file (rather than two that inevitably drift) is
deliberate; don't fork guidance between the two.

## Claude Code-specific notes

- **This is a standalone repository.** It used to live nested inside a
  consumer app for local dogfooding; it no longer does. Nothing outside
  this folder governs it — no parent `CLAUDE.md`, no enclosing
  `tsconfig.json`/`eslint.config.js`, no parent `.gitignore`.
- **No framework, no build step, no TypeScript.** This is a
  zero-dependency Node tool with its own small rule set (see AGENTS.md).
  Don't reach for a bundler, a type system, React, Zod, or any
  application-framework pattern in here. `src/assets/widget.js` and
  `src/assets/shell.html` are plain files served to a browser as-is; the
  only checks that exist are `node --test test/*.test.js`.
- **Dogfooding against a consumer app** now means running `sidebranch`
  from *that* app's root (it resolves `repoRoot` from `process.cwd()`,
  exactly like git — see AGENTS.md non-negotiable 4). Install it there
  with `npm link` / `npx /path/to/sidebranch`, don't copy this folder
  into someone else's tree again.
