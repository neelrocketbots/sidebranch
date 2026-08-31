import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as gitops from "../src/gitops.js";
import { projectDataDir } from "../src/config.js";

const run = promisify(execFile);
const git = (cwd, ...args) => run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "sidebranch.js");

let tmp, home, repo, root;

/** Run the real CLI binary as a subprocess, cwd'd into the fixture repo. */
function sidebranch(args) {
  return run(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...process.env, SIDEBRANCH_HOME: home },
  });
}

/** Realpath-safe check (see gitops.findWorktree) that `dir` is a live worktree of `repo`. */
async function isTrackedWorktree(dir) {
  return Boolean(await gitops.findWorktree(await gitops.listWorktrees(repo), dir));
}

let priorHome;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sidebranch-cli-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  // projectDataDir() is called both in-process (to compute the expected
  // pane path) and by the spawned CLI subprocess (via its own env below) —
  // both must resolve against the same sandboxed home, or this test suite
  // leaks real worktrees into the developer's actual ~/.sidebranch.
  priorHome = process.env.SIDEBRANCH_HOME;
  process.env.SIDEBRANCH_HOME = home;
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "Test");
  await fs.writeFile(path.join(repo, "index.html"), "<h1>main</h1>\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "branch", "feature");
  // Leave "main"/"feature" free for panes to check out normally (branch,
  // not detached) — a pane checking out a branch the primary tree still
  // holds gets silently detached instead (see gitops.checkoutInWorktree).
  await git(repo, "branch", "workspace");
  await git(repo, "switch", "workspace");
  // `git rev-parse --show-toplevel` (used internally by repoRoot/projectDataDir)
  // resolves symlinks, e.g. macOS's /var -> /private/var — so the pane paths
  // built here must key off the *resolved* root, exactly like the CLI
  // subprocess does internally, or the two sides derive different
  // ~/.sidebranch/projects/<slug> hashes and never see the same panes.
  root = await gitops.repoRoot(repo);
});

after(async () => {
  if (priorHome === undefined) delete process.env.SIDEBRANCH_HOME;
  else process.env.SIDEBRANCH_HOME = priorHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("clean reports and exits 0 when there are no panes yet", async () => {
  const { stdout } = await sidebranch(["clean", "--yes"]);
  assert.match(stdout, /No panes found/);
});

test("clean --yes removes a real pane worktree without a daemon running", async () => {
  const paneDir = path.join(projectDataDir(root), "panes", "a");
  await fs.mkdir(path.dirname(paneDir), { recursive: true });
  await gitops.addWorktree(repo, paneDir, "main");
  assert.ok(await isTrackedWorktree(paneDir));

  const { stdout } = await sidebranch(["clean", "--yes"]);
  assert.match(stdout, /removed a \(main\)/);
  assert.ok(!(await isTrackedWorktree(paneDir)));
  await assert.rejects(() => fs.access(paneDir));
});

test("clean --pane targets a single pane and leaves the other untouched", async () => {
  const panesRoot = path.join(projectDataDir(root), "panes");
  const paneA = path.join(panesRoot, "a");
  const paneB = path.join(panesRoot, "b");
  await fs.mkdir(panesRoot, { recursive: true });
  await gitops.addWorktree(repo, paneA, "main");
  await gitops.addWorktree(repo, paneB, "feature");

  await sidebranch(["clean", "--pane", "a", "--yes"]);

  assert.ok(!(await isTrackedWorktree(paneA)));
  assert.ok(await isTrackedWorktree(paneB));

  await gitops.removeWorktree(repo, paneB); // tidy up for later tests
});

test("clean --pane with an unknown id fails loudly instead of silently no-op'ing", async () => {
  const panesRoot = path.join(projectDataDir(root), "panes");
  await fs.mkdir(path.join(panesRoot, "a"), { recursive: true });
  await gitops.addWorktree(repo, path.join(panesRoot, "a"), "main");
  try {
    await assert.rejects(
      () => sidebranch(["clean", "--pane", "z", "--yes"]),
      (err) => err.code === 1 && /No pane "z"/.test(err.stderr)
    );
  } finally {
    await gitops.removeWorktree(repo, path.join(panesRoot, "a"));
  }
});

test("clean without --yes refuses to delete anything from a non-interactive caller", async () => {
  const paneDir = path.join(projectDataDir(root), "panes", "a");
  await fs.mkdir(path.dirname(paneDir), { recursive: true });
  await gitops.addWorktree(repo, paneDir, "main");

  try {
    // A spawned child's stdin is not a TTY, so this exercises the
    // safe-by-default, non-interactive path rather than the y/N prompt.
    await assert.rejects(
      () => sidebranch(["clean"]),
      (err) => err.code === 1 && /Re-run with --yes/.test(err.stderr)
    );
    assert.ok(await isTrackedWorktree(paneDir));
  } finally {
    await gitops.removeWorktree(repo, paneDir);
  }
});

/* --------------------------- daemon record / stop -------------------------- */

const recordPath = () => path.join(projectDataDir(root), "daemon.json");

async function writeFakeRecord(rec) {
  await fs.mkdir(path.dirname(recordPath()), { recursive: true });
  await fs.writeFile(recordPath(), JSON.stringify({ port: 49611, repo: root, startedAt: 1, version: 1, ...rec }));
}

async function recordExists() {
  try { await fs.access(recordPath()); return true; } catch { return false; }
}

test("stop: no record is a no-op, not an error", async () => {
  await fs.rm(recordPath(), { force: true });
  const { stdout } = await sidebranch(["stop"]);
  assert.match(stdout, /No sidebranch daemon recorded/);
});

test("stop: a record whose pid is gone is cleared, not signalled", async () => {
  await writeFakeRecord({ pid: 999991 });
  const { stdout } = await sidebranch(["stop"]);
  assert.match(stdout, /no longer running/);
  assert.equal(await recordExists(), false);
});

test("stop: a recycled pid belonging to another process is never killed", async () => {
  // The dangerous case. The OS reuses pids, so a record left behind by a
  // SIGKILLed daemon can name a completely unrelated process. Liveness alone
  // must never be enough to justify sending it a signal — the /healthz probe
  // is what distinguishes "our daemon" from "a stranger that inherited the
  // pid". If this test ever fails, `sidebranch stop` is killing bystanders.
  const victim = (await import("node:child_process")).spawn(
    process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" }
  );
  try {
    await writeFakeRecord({ pid: victim.pid, port: 49599 }); // nothing answers there
    const { stdout } = await sidebranch(["stop"]);
    assert.match(stdout, /is alive but is not a sidebranch daemon/);
    assert.equal(victim.killed, false);
    assert.equal(victim.exitCode, null, "the innocent process must still be running");
    assert.equal(await recordExists(), false, "the stale record should still be cleared");
  } finally {
    victim.kill("SIGKILL");
  }
});

test("stop: a corrupt record reads as no daemon rather than throwing", async () => {
  await fs.mkdir(path.dirname(recordPath()), { recursive: true });
  await fs.writeFile(recordPath(), "not json{");
  const { stdout } = await sidebranch(["stop"]);
  assert.match(stdout, /No sidebranch daemon recorded/);
});

test("clean: refuses while a daemon is running, proceeds when it is not", async () => {
  // A live record blocks clean — this is the guarantee that replaced the
  // README's "stop the daemon first" prose with an actual check. Simulated
  // with this process as the pid plus a real server on the recorded port,
  // since both liveness proofs have to hold.
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(49598, "127.0.0.1", r));
  try {
    await writeFakeRecord({ pid: process.pid, port: 49598 });
    await assert.rejects(
      () => sidebranch(["clean", "--yes"]),
      (err) => /daemon is running for this repo/.test(err.stderr) && err.code === 1
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
  // Same record, but nothing answers on the port any more: clean is allowed.
  const res = await sidebranch(["clean", "--yes"]);
  assert.doesNotMatch(res.stdout, /daemon is running/);
});
