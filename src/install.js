/**
 * install.js — decide when a checkout requires re-installing dependencies,
 * and run the project's configured install command when it does.
 *
 * Framework-agnostic: we don't know or care what the package manager is.
 * We hash a set of well-known dependency manifests (extendable via config)
 * and run `config.install` only when the combined hash changes. The install
 * command itself comes from the project's own config file, which is the
 * same trust level as its package.json scripts.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_LOCKFILES = [
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "requirements.txt", "poetry.lock", "uv.lock", "Pipfile.lock",
  "Gemfile.lock", "go.sum", "Cargo.lock", "composer.lock", "mix.lock",
];

/** Stable hash of all present lockfiles in a worktree (name + content). */
export async function lockfileHash(dir, lockfiles = DEFAULT_LOCKFILES) {
  const h = crypto.createHash("sha256");
  let any = false;
  for (const name of [...lockfiles].sort()) {
    const p = path.join(dir, name);
    try {
      const buf = await fs.readFile(p);
      any = true;
      h.update(name);
      h.update("\x00");
      h.update(buf);
      h.update("\x00");
    } catch {
      /* file absent — fine */
    }
  }
  return any ? h.digest("hex") : "no-lockfiles";
}

/**
 * Run the configured install command inside a worktree.
 * The command is split into argv ourselves (no shell) — quoting in the
 * config supports simple "word word" splitting only, which covers every
 * real install command and avoids handing config a shell.
 *
 * `ring`, if supplied, accumulates raw stdout/stderr chunks (the caller owns
 * it and can inspect it later, e.g. to serve a pane's full install log) and
 * also backs the tail baked into a failure's error message, so "exited with
 * code 1" becomes "exited with code 1: npm ERR! 404 Not Found — ..." without
 * requiring a caller to go re-run the command by hand to see why.
 */
export function runInstall(dir, installCmd, { onOutput, ring = [], timeoutMs = 15 * 60_000 } = {}) {
  const argv = splitCommand(installCmd);
  if (argv.length === 0) return Promise.resolve({ skipped: true });
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dir,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Install timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const forward = (buf) => {
      const text = buf.toString();
      pushRing(ring, text);
      onOutput?.(text);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ skipped: false });
      const tail = tailText(ring);
      reject(new Error(`Install command exited with code ${code}${tail ? `: ${tail}` : ""}`));
    });
  });
}

/** Bounded ring buffer: push a chunk, drop the oldest once over `max` entries. */
export function pushRing(ring, chunk, max = 400) {
  ring.push(chunk);
  if (ring.length > max) ring.shift();
}

/**
 * Join a ring buffer's captured chunks and return the trailing `maxChars`,
 * with newlines/runs of whitespace collapsed to " › " so a multi-line tool
 * error still reads as one line for inline display (e.g. a status bubble).
 * Callers that want the untouched, multi-line log (e.g. a log-viewing
 * endpoint) should read the ring directly instead of going through this.
 */
export function tailText(ring, maxChars = 300) {
  const joined = ring.join("").trim();
  if (!joined) return "";
  const slice = joined.length > maxChars ? joined.slice(-maxChars) : joined;
  return slice.trim().replace(/\s*\n\s*/g, " › ");
}

/** Minimal argv splitter: whitespace-separated, with double-quote grouping. */
export function splitCommand(cmd) {
  if (typeof cmd !== "string") return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
