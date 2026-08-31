import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as gitops from "../src/gitops.js";

const run = promisify(execFile);
const git = (cwd, ...args) => run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let tmp, repo;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sidebranch-test-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "Test");
  await fs.writeFile(path.join(repo, "index.html"), "<h1>main</h1>\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "branch", "feature/one");
  await git(repo, "switch", "feature/one");
  await fs.writeFile(path.join(repo, "index.html"), "<h1>feature one</h1>\n");
  await git(repo, "commit", "-am", "feature change");
  await git(repo, "switch", "main");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("repoRoot / currentBranch / listBranches", async () => {
  assert.equal(await fs.realpath(await gitops.repoRoot(repo)), await fs.realpath(repo));
  assert.equal(await gitops.currentBranch(repo), "main");
  const branches = await gitops.listBranches(repo);
  const names = branches.map((b) => b.name).sort();
  assert.deepEqual(names, ["feature/one", "main"]);
});

test("assertValidBranchName rejects hostile input before git ever runs", async () => {
  await assert.rejects(() => gitops.assertValidBranchName(repo, "-D"), /Invalid branch name/);
  await assert.rejects(() => gitops.assertValidBranchName(repo, "a;touch pwned"), /Invalid branch name/);
  await assert.rejects(() => gitops.assertValidBranchName(repo, "a..b"), /Invalid branch name/);
  await gitops.assertValidBranchName(repo, "feature/one"); // does not throw
});

test("worktree lifecycle: add, checkout, dirty protection, remove", async () => {
  const wt = path.join(tmp, "pane-a");
  await gitops.addWorktree(repo, wt, "feature/one");

  // Correct content checked out
  const html = await fs.readFile(path.join(wt, "index.html"), "utf8");
  assert.match(html, /feature one/);

  // Switch the same worktree to main
  const head = await gitops.checkoutInWorktree(repo, wt, "main");
  assert.equal(head.subject, "initial");
  assert.match(await fs.readFile(path.join(wt, "index.html"), "utf8"), /main/);

  // Dirty review tree: refuse by default, discard only when told to.
  await fs.writeFile(path.join(wt, "index.html"), "tampered\n");
  await assert.rejects(
    () => gitops.checkoutInWorktree(repo, wt, "feature/one"),
    (err) => err.code === "EDIRTY"
  );
  const head2 = await gitops.checkoutInWorktree(repo, wt, "feature/one", { discard: true });
  assert.equal(head2.subject, "feature change");

  // The user's main tree was never touched throughout.
  assert.ok(await gitops.isClean(repo));
  assert.equal(await gitops.currentBranch(repo), "main");

  await gitops.removeWorktree(repo, wt);
  const listed = await gitops.listWorktrees(repo);
  assert.ok(!listed.some((w) => path.resolve(w.path) === path.resolve(wt)));
});

test("branch checked out in the user's tree is opened detached, not stolen", async () => {
  const wt = path.join(tmp, "pane-b");
  // "main" is checked out in the primary working tree; a naive
  // `git worktree add` on it would fail. We detach instead.
  await gitops.addWorktree(repo, wt, "main");
  assert.match(await fs.readFile(path.join(wt, "index.html"), "utf8"), /main/);
  assert.equal(await gitops.currentBranch(repo), "main"); // untouched
  await gitops.removeWorktree(repo, wt);
});

test("remote-only branches are checked out with a local tracking branch", async () => {
  // Simulate a PR branch that exists only on the remote.
  const origin = path.join(tmp, "origin.git");
  await run("git", ["clone", "--bare", repo, origin]);
  const clone = path.join(tmp, "clone");
  await run("git", ["clone", origin, clone]);
  await git(clone, "config", "user.email", "t@example.com");
  await git(clone, "config", "user.name", "Test");

  // Push a new branch to origin from a third place
  const wt0 = path.join(tmp, "author");
  await run("git", ["clone", origin, wt0]);
  await git(wt0, "config", "user.email", "a@example.com");
  await git(wt0, "config", "user.name", "Author");
  await git(wt0, "switch", "-c", "pr/remote-only");
  await fs.writeFile(path.join(wt0, "index.html"), "<h1>remote pr</h1>\n");
  await git(wt0, "commit", "-am", "pr work");
  await git(wt0, "push", "origin", "pr/remote-only");

  await gitops.fetchAll(clone);
  const branches = await gitops.listBranches(clone);
  const pr = branches.find((b) => b.name === "pr/remote-only");
  assert.ok(pr, "remote branch listed");
  assert.equal(pr.local, false);

  const wt = path.join(tmp, "pane-c");
  await gitops.addWorktree(clone, wt, "pr/remote-only");
  assert.match(await fs.readFile(path.join(wt, "index.html"), "utf8"), /remote pr/);
  await gitops.removeWorktree(clone, wt);
});
