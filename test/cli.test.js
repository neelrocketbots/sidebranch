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
