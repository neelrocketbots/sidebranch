/**
 * cli.js — `sidebranch init | start | clean | doctor`
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { loadConfig, CONFIG_FILENAME, DEFAULTS, projectDataDir } from "./config.js";
import * as gitops from "./gitops.js";
import { Manager } from "./manager.js";
import { Daemon } from "./daemon.js";

const HELP = `sidebranch — local PR review sidecar

Usage:
  sidebranch init            Write a starter ${CONFIG_FILENAME} in this repo
  sidebranch start [--port]  Start the daemon (default port 49400)
  sidebranch clean [--pane a|b] [--yes]
                              Remove stale pane worktrees for this repo
  sidebranch doctor          Check environment and configuration
  sidebranch help

Then add to your app (dev builds only):
  <script src="http://localhost:49400/widget.js" defer></script>
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":   return init();
    case "start":  return start(parseFlags(rest));
    case "clean":  return clean(parseCleanFlags(rest));
    case "doctor": return doctor();
    case "help":
    case undefined:
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

function parseFlags(rest) {
  const flags = { port: 49400 };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port") flags.port = Number.parseInt(rest[++i], 10);
  }
  if (!Number.isInteger(flags.port) || flags.port < 1024 || flags.port > 65000) {
    throw new Error("--port must be an integer between 1024 and 65000");
  }
  return flags;
}

async function init() {
  const root = await gitops.repoRoot(process.cwd());
  const file = path.join(root, CONFIG_FILENAME);
  try {
    await fs.access(file);
    process.stdout.write(`${CONFIG_FILENAME} already exists at ${root}\n`);
    return 0;
  } catch { /* create it */ }
  const starter = {
    dev: DEFAULTS.dev,
    install: DEFAULTS.install,
    ready: { path: "/" },
  };
  await fs.writeFile(file, JSON.stringify(starter, null, 2) + "\n");
  process.stdout.write(
    `Wrote ${file}\n\n` +
    `Edit "dev" and "install" for your stack. Examples:\n` +
    `  Next.js   { "dev": "npm run dev",              "install": "npm install" }\n` +
    `  Vite      { "dev": "npx vite --port {port}",   "install": "pnpm install" }\n` +
    `  Python    { "dev": "python3 -m http.server {port}", "install": "" }\n\n` +
    `Then run: npx sidebranch start\n`
  );
  return 0;
}

async function start({ port }) {
  const root = await gitops.repoRoot(process.cwd());
  const config = await loadConfig(root);
  const manager = new Manager({ repoRoot: root, config });
  const daemon = new Daemon({ manager, port });
  await daemon.start();

  process.stdout.write(
    `sidebranch daemon running\n` +
    `  repo      ${root}\n` +
    `  worktrees ${projectDataDir(root)}\n` +
    `  bound     http://127.0.0.1:${port}  (loopback only)\n\n` +
    `Add to your app (dev only):\n` +
    `  <script src="http://localhost:${port}/widget.js" defer></script>\n\n` +
    `Compare view: open via the widget, or http://localhost:${port}/shell\n`
  );

  const shutdown = async () => {
    process.stdout.write("\nShutting down panes…\n");
    await daemon.stop().catch(() => {});
    process.stdout.write(
      "Panes remain on disk for next time. Run `npx sidebranch clean` to tear down worktrees you no longer need.\n"
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {}); // run until signaled
}

function parseCleanFlags(rest) {
  const flags = { pane: null, yes: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--pane") flags.pane = rest[++i];
    else if (rest[i] === "--yes" || rest[i] === "-y") flags.yes = true;
  }
  return flags;
}

/**
 * Panes are worktrees that outlive the daemon (no `sidebranch stop`/PID
 * file tracks them) — this walks the on-disk pane directories for the
 * current repo and cross-references `git worktree list` to report what's
 * there, without requiring a running daemon.
 */
async function findPanes(root, paneFilter) {
  const panesRoot = path.join(projectDataDir(root), "panes");
  let entries;
  try {
    entries = await fs.readdir(panesRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const worktrees = await gitops.listWorktrees(root);
  const rows = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = path.join(panesRoot, e.name);
        const wt = await gitops.findWorktree(worktrees, dir);
        const label = wt ? (wt.branch ?? `detached @ ${(wt.head ?? "").slice(0, 7)}`) : "not a worktree";
        return { id: e.name, dir, tracked: Boolean(wt), label };
      })
  );
  return paneFilter ? rows.filter((r) => r.id === paneFilter) : rows;
}

async function clean({ pane, yes }) {
  const root = await gitops.repoRoot(process.cwd());
  const rows = await findPanes(root, pane);

  if (pane && rows.length === 0) {
    process.stderr.write(`No pane "${pane}" found for ${root}\n`);
    return 1;
  }
  if (rows.length === 0) {
    process.stdout.write(`No panes found for ${root}\n`);
    return 0;
  }

  process.stdout.write(`Panes for ${root}:\n`);
  for (const r of rows) process.stdout.write(`  ${r.id}   ${r.label}   ${r.dir}\n`);
  process.stdout.write(
    "\nThis removes the worktree(s) listed above; nothing else is touched. If the\n" +
    "sidebranch daemon for this project is still running, stop it first — clean\n" +
    "doesn't track live dev-server processes, only git worktree state.\n\n"
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`Re-run with --yes to remove ${rows.length === 1 ? "this pane" : "these panes"}.\n`);
      return 1;
    }
    const ok = await confirm(`Remove ${rows.length} pane${rows.length === 1 ? "" : "s"}? [y/N] `);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }

  let failures = 0;
  for (const r of rows) {
    try {
      if (r.tracked) await gitops.removeWorktree(root, r.dir);
      else await fs.rm(r.dir, { recursive: true, force: true });
      process.stdout.write(`removed ${r.id} (${r.label})\n`);
    } catch (err) {
      failures++;
      process.stderr.write(`failed to remove ${r.id}: ${err.message}\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function doctor() {
  const checks = [];
  const push = (name, ok, note = "") => checks.push({ name, ok, note });

  try {
    const root = await gitops.repoRoot(process.cwd());
    push("git repository", true, root);
    try {
      const cfg = await loadConfig(root);
      push(`${CONFIG_FILENAME}`, true, `dev="${cfg.dev}"  install="${cfg.install}"`);
    } catch (e) {
      push(CONFIG_FILENAME, false, e.message);
    }
  } catch {
    push("git repository", false, "run inside a git repo");
  }
  push("node version", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node);

  for (const c of checks) {
    process.stdout.write(`${c.ok ? " ok " : "FAIL"}  ${c.name}${c.note ? ` — ${c.note}` : ""}\n`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
