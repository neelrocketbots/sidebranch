/**
 * daemonfile.js — the record of "is a daemon running for this repo?".
 *
 * Until this existed, nothing tracked live daemons: `clean` could remove the
 * worktree out from under a running dev server, `start` could launch a second
 * daemon fighting the first over the same panes, and there was no `stop` at
 * all. One small JSON file per project answers all three.
 *
 * The file lives beside the panes it describes, in `projectDataDir(repo)`, so
 * it is scoped per repo exactly like the worktrees are — two projects each
 * running a daemon is normal and must keep working.
 *
 * A PID on disk is a claim, not a fact: the process may have been SIGKILLed
 * without cleanup, and the OS may since have recycled its pid onto something
 * else entirely. So `readRecord()` never trusts the file alone — it proves
 * liveness two ways (the pid exists, *and* something answers /healthz on the
 * recorded port) and reports which of those hold. Acting on a stale record is
 * how a tool ends up killing an unrelated process.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { projectDataDir } from "./config.js";
import { isValidPort } from "./security.js";

const FILENAME = "daemon.json";

export function daemonFilePath(repoRoot) {
  return path.join(projectDataDir(repoRoot), FILENAME);
}

/** Record this process as the daemon for `repoRoot`. */
export async function writeRecord(repoRoot, { port }) {
  const file = daemonFilePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record = {
    pid: process.pid,
    port,
    repo: repoRoot,
    startedAt: Date.now(),
    version: 1,
  };
  // Write-then-rename so a crash mid-write can't leave a truncated file that
  // every later command has to defend against parsing.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n");
  await fs.rename(tmp, file);
  return record;
}

/** Remove the record, if it is ours. Never throws. */
export async function clearRecord(repoRoot, { onlyIfPid = null } = {}) {
  const file = daemonFilePath(repoRoot);
  try {
    if (onlyIfPid !== null) {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (raw?.pid !== onlyIfPid) return false;
    }
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the record and establish how much of it is still true.
 *
 * Returns null when there is no record at all. Otherwise:
 *   { pid, port, startedAt, pidAlive, healthy, running }
 *
 * `running` is the only field callers should branch on for "is a sidebranch
 * daemon serving this repo right now". It requires *both* proofs: a live pid
 * rules out a record left behind by a killed process, and a /healthz answer
 * rules out a recycled pid belonging to some unrelated program. Either alone
 * is a way to mistake a stranger's process for our own.
 */
export async function readRecord(repoRoot) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(daemonFilePath(repoRoot), "utf8"));
  } catch {
    return null; // absent, unreadable, or corrupt — all mean "no daemon"
  }
  if (!Number.isInteger(raw?.pid) || raw.pid <= 0 || !isValidPort(raw?.port)) return null;

  const pidAlive = isPidAlive(raw.pid);
  const healthy = pidAlive ? await probeHealth(raw.port) : false;
  return {
    pid: raw.pid,
    port: raw.port,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    pidAlive,
    healthy,
    running: pidAlive && healthy,
  };
}

/** Signal 0 tests for existence and permission without delivering a signal. */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive, and
    // definitely not ours to signal.
    return err.code === "EPERM";
  }
}

/**
 * Ask the recorded port whether a sidebranch daemon answers there.
 *
 * `/healthz` is unauthenticated and passes the loopback gate from this
 * process, so this needs no token. A non-sidebranch server on that port
 * answers something that isn't `{ok:true}`, which is exactly the case this
 * is here to catch.
 */
export async function probeHealth(port, { timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SIGTERM the daemon and wait for it to actually go away.
 *
 * Deliberately never escalates to SIGKILL: the daemon's SIGTERM handler is
 * what shuts down pane dev servers cleanly, and killing it outright would
 * orphan those children — the exact mess this file exists to prevent. If it
 * won't exit, say so and let the user decide.
 */
export async function stopDaemon(record, { timeoutMs = 10_000, pollMs = 100 } = {}) {
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") return { ok: true, alreadyGone: true };
    throw err;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(record.pid)) return { ok: true, alreadyGone: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, alreadyGone: false };
}
