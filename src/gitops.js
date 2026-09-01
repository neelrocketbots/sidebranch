/**
 * gitops.js — every git interaction in the tool.
 *
 * Rules:
 *   - execFile with argument arrays only. There is no shell anywhere in
 *     this file, so metacharacters in branch names cannot become commands.
 *   - Ref names are validated twice: our conservative isSafeRefName(),
 *     then git's own `check-ref-format --branch`.
 *   - Review worktrees are treated as append-only environments: they are
 *     never expected to be dirty. If one is dirty (someone hand-edited it),
 *     we refuse to touch it unless the caller passes { discard: true }.
 *     Nothing in this tool ever stashes or resets the user's primary
 *     working tree — we never even run commands against it beyond reads.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fsp from "node:fs/promises";

import { isSafeRefName } from "./security.js";

const execFileP = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never hang on credential prompts
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? "",
};

async function git(cwd, args, opts = {}) {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: GIT_ENV,
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts.timeout ?? 120_000,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const msg = (err.stderr || err.message || "git error").toString().trim();
    const e = new Error(msg);
    e.code = "EGIT";
    throw e;
  }
}

/** Throws unless `name` is a plausible, safe branch name per git itself. */
export async function assertValidBranchName(repo, name) {
  if (!isSafeRefName(name)) {
    const e = new Error(`Invalid branch name: ${JSON.stringify(String(name).slice(0, 80))}`);
    e.code = "EBADREF";
    throw e;
  }
  await git(repo, ["check-ref-format", "--branch", name]);
}

export async function repoRoot(dir) {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentBranch(dir) {
  return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function headCommit(dir) {
  const out = await git(dir, ["log", "-1", "--format=%H%x1f%h%x1f%ci%x1f%s"]);
  const [sha, short, date, subject] = out.trim().split("\x1f");
  return { sha, short, date, subject };
}

export async function isClean(dir) {
  const out = await git(dir, ["status", "--porcelain"]);
  return out.trim() === "";
}

/** True if the repo is mid-merge/rebase/etc. — refuse to operate. */
export async function inProgressOperation(dir) {
  const out = await git(dir, [
    "rev-parse", "--git-path", "MERGE_HEAD",
    "--git-path", "REBASE_HEAD",
    "--git-path", "CHERRY_PICK_HEAD",
  ]);
  const gitDirPaths = out.trim().split("\n");
  const fs = await import("node:fs");
  return gitDirPaths.some((p) => fs.existsSync(path.resolve(dir, p)));
}

/**
 * List local and remote branches, most recently committed first.
 * Remote refs are reported without the remote prefix, deduped against
 * local branches.
 */
export async function listBranches(repo) {
  const fmt = "%(refname)%1f%(refname:short)%1f%(committerdate:iso-strict)%1f%(objectname:short)%1f%(subject)";
  const out = await git(repo, [
    "for-each-ref", "--sort=-committerdate", `--format=${fmt.replaceAll("%1f", "%01")}`,
    "refs/heads", "refs/remotes",
  ]);
  const seen = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [refname, short, date, sha, subject] = line.split("\x01");
    if (short.endsWith("/HEAD")) continue;
    let name = short;
    let remote = null;
    if (refname.startsWith("refs/remotes/")) {
      const parts = short.split("/");
      remote = parts.shift();
      name = parts.join("/");
    }
    if (!isSafeRefName(name)) continue; // skip anything we would refuse to check out
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, { name, sha, date, subject, local: !remote, remotes: remote ? [remote] : [] });
    } else if (remote) {
      existing.remotes.push(remote);
    } else {
      existing.local = true;
      existing.sha = sha;
      existing.date = date;
      existing.subject = subject;
    }
  }
  return [...seen.values()];
}

export async function fetchAll(repo) {
  await git(repo, ["fetch", "--all", "--prune"], { timeout: 180_000 });
}

/* ------------------------------- worktrees ------------------------------- */

export async function listWorktrees(repo) {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const items = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9), branch: null, head: null, detached: false };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (cur && line === "detached") {
      cur.detached = true;
    }
  }
  if (cur) items.push(cur);
  return items;
}

/**
 * Resolve `dir` through the filesystem (symlinks and all — notably macOS's
 * /var -> /private/var) so paths built from os.tmpdir() compare equal to
 * what `git worktree list` reports. A deleted directory can't be realpathed
 * directly, so walk up to the deepest ancestor that still exists, realpath
 * that, and re-append the missing tail — otherwise a stale registration for
 * a removed worktree silently fails to match on macOS tmp paths, and the
 * heal in ensurePane never fires.
 */
async function resolvedPath(dir) {
  const abs = path.resolve(dir);
  let base = abs;
  const missing = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(base), ...missing.reverse());
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return abs;
      missing.push(path.basename(base));
      base = parent;
    }
  }
}

/**
 * Find the `git worktree list` entry for `dir`, if any. Realpath-safe (see
 * `resolvedPath`) — a plain path.resolve() comparison silently fails to
 * match on macOS whenever the caller's path crosses the /var symlink.
 */
export async function findWorktree(worktrees, dir) {
  const target = await resolvedPath(dir);
  for (const w of worktrees) {
    if ((await resolvedPath(w.path)) === target) return w;
  }
  return null;
}

/**
 * Create a review worktree at `dir` checked out to `branch`.
 * If the branch only exists on a remote, a local tracking branch is created.
 * Uses --detach + switch so a branch already checked out elsewhere (e.g. the
 * user's own working tree) doesn't block worktree creation.
 */
export async function addWorktree(repo, dir, branch) {
  await assertValidBranchName(repo, branch);
  await git(repo, ["worktree", "add", "--detach", "--", dir]);
  await checkoutInWorktree(repo, dir, branch);
}

export async function removeWorktree(repo, dir) {
  await git(repo, ["worktree", "remove", "--force", "--", dir]);
}

/**
 * Clear registrations whose directories no longer exist on disk. Metadata
 * only — prune never touches a working tree, ours or the user's.
 */
export async function pruneWorktrees(repo) {
  await git(repo, ["worktree", "prune"]);
}

/**
 * Point an existing review worktree at `branch`.
 * Review worktrees are never hand-edited, so a dirty tree here means
 * something unexpected happened; refuse unless the caller opts into
 * discarding, and even then only files inside the *review* tree are touched.
 */
export async function checkoutInWorktree(repo, dir, branch, { discard = false } = {}) {
  await assertValidBranchName(repo, branch);
  if (await inProgressOperation(dir)) {
    const e = new Error("Worktree has an in-progress merge/rebase; resolve or recreate it.");
    e.code = "EBUSYTREE";
    throw e;
  }
  if (!(await isClean(dir))) {
    if (!discard) {
      const e = new Error(
        "Review worktree has uncommitted changes (it should never be edited by hand). " +
        "Re-run with discard=true to reset it, or clean it up manually."
      );
      e.code = "EDIRTY";
      throw e;
    }
    await git(dir, ["reset", "--hard"]);
    await git(dir, ["clean", "-fd"]);
  }

  const localExists = (await git(dir, ["branch", "--list", "--format=%(refname:short)", branch]))
    .split("\n").map((s) => s.trim()).includes(branch);

  if (localExists) {
    // Branch may be checked out in the user's main tree; review trees track
    // the same commit in detached mode in that case rather than stealing it.
    try {
      await git(dir, ["switch", "--no-guess", branch]);
    } catch (err) {
      if (/already used by worktree|already checked out/i.test(err.message)) {
        await git(dir, ["switch", "--detach", branch]);
      } else {
        throw err;
      }
    }
  } else {
    // Creates a local branch tracking the remote one (guess mode), which is
    // exactly the PR-review case.
    await git(dir, ["switch", branch]);
  }
  return headCommit(dir);
}
