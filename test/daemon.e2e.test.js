import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Manager } from "../src/manager.js";
import { Daemon, API_VERSION } from "../src/daemon.js";
import { normalize } from "../src/config.js";

const run = promisify(execFile);
const git = (cwd, ...args) => run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

const PORT = 4499;
const BASE = `http://127.0.0.1:${PORT}`;
let tmp, repo, daemon, manager, token;

const api = (p, { method = "GET", body, headers = {} } = {}) =>
  fetch(BASE + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sidebranch-e2e-"));
  process.env.SIDEBRANCH_HOME = path.join(tmp, "home");
  repo = path.join(tmp, "app");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "Test");
  await fs.writeFile(path.join(repo, "index.html"), "<h1>MAIN</h1>\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "main");
  await git(repo, "switch", "-c", "pr/button-color");
  await fs.writeFile(path.join(repo, "index.html"), "<h1>PR</h1>\n");
  await git(repo, "commit", "-am", "pr");
  await git(repo, "switch", "main");

  // A framework-agnostic "dev server": python's http.server, port injected
  // via the {port} placeholder — exactly how a real polyglot repo would
  // configure it.
  const config = normalize({
    dev: "python3 -m http.server {port} --bind 127.0.0.1",
    install: "",
    basePort: 4560,
  });
  manager = new Manager({ repoRoot: repo, config });
  daemon = new Daemon({ manager, port: PORT });
  await daemon.start();
  token = daemon.token;
});

after(async () => {
  await daemon.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

test("auth gauntlet: every bad request shape is rejected", async () => {
  // no token
  const saved = token; token = null;
  assert.equal((await api("/api/state")).status, 401);
  token = saved;

  // wrong token
  assert.equal(
    (await api("/api/state", { headers: { Authorization: "Bearer " + "0".repeat(64) } })).status,
    401
  );

  // DNS-rebinding shape: loopback socket, hostile Host header. fetch()
  // refuses to spoof Host, so go through node:http like a real attack would.
  const rebound = await new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/api/state",
          headers: { Host: "evil.example", Authorization: `Bearer ${token}` } },
        (res) => { res.resume(); resolve(res.statusCode); }
      );
      req.on("error", reject);
      req.end();
    });
  });
  assert.equal(rebound, 403);

  // hostile Origin (a remote page trying to reach the daemon)
  assert.equal((await api("/api/state", { headers: { Origin: "https://evil.example" } })).status, 403);

  // loopback origin passes the gate (and needs the token, which it has here)
  assert.equal((await api("/api/state", { headers: { Origin: "http://localhost:5173" } })).status, 200);

  // CORS is never granted to non-loopback origins even on public assets
  const res = await fetch(BASE + "/widget.js", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("hostile pane/branch inputs are rejected with 400", async () => {
  const r1 = await api("/api/pane", { method: "POST", body: { pane: "a", branch: "-D" } });
  assert.equal(r1.status, 400);
  const r2 = await api("/api/pane", { method: "POST", body: { pane: "a", branch: "x;id" } });
  assert.equal(r2.status, 400);
  const r3 = await api("/api/pane", { method: "POST", body: { pane: "../..", branch: "main" } });
  assert.equal(r3.status, 400);
});

test("widget & shell are served with the session token embedded", async () => {
  const w = await (await fetch(BASE + "/widget.js")).text();
  assert.ok(w.includes(token));
  assert.ok(!w.includes("__SIDEBRANCH_TOKEN__"));
  const s = await (await fetch(BASE + "/shell")).text();
  assert.ok(s.includes(token));
  assert.ok(s.includes("Content-Security-Policy") === false); // header, not body
});

test("widget.js is assembled from core + tag boot, with credentials only in the boot", async () => {
  const w = await (await fetch(BASE + "/widget.js")).text();
  // Core defines the entry point; the boot calls it. Both halves must be
  // present — serving core alone renders nothing at all, silently.
  assert.match(w, /globalThis\.__sidebranchStart \?\?=/);
  assert.match(w, /start\(\{ token: "/);
  assert.ok(w.includes(token));
  assert.ok(!w.includes("__SIDEBRANCH_TOKEN__"));
  assert.ok(!w.includes("__SIDEBRANCH_PORT__"));

  // The token must reach the widget as an argument, never as a literal baked
  // into the core body — that separation is what lets the extension ship core
  // verbatim in its own package without shipping a secret.
  const core = await fs.readFile(new URL("../src/assets/widget-core.js", import.meta.url), "utf8");
  assert.ok(!core.includes("__SIDEBRANCH_TOKEN__"));
  assert.ok(!core.includes(token));
});

test("GET /handshake bootstraps a token for callers that can't take a template", async () => {
  const res = await fetch(BASE + "/handshake");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.token, token);
  assert.equal(body.port, PORT);
  assert.equal(body.widget, true);
  assert.equal(typeof body.version, "string");
  assert.equal(body.apiVersion, API_VERSION);

  // It must sit OUTSIDE /api/*: it exists to bootstrap the bearer token, so
  // requiring the bearer token would make it useless.
  const noAuth = await fetch(BASE + "/handshake", { headers: {} });
  assert.equal(noAuth.status, 200);
});

test('"widget": false is honored in both delivery channels', async () => {
  // The tag channel serves a no-op body. The extension can't be told that way
  // — it ships the widget itself — so the handshake has to report it, or the
  // config flag would silently apply to only one of the two channels.
  const { EventEmitter } = await import("node:events");
  const stub = new EventEmitter();
  stub.config = { widget: false };
  stub.shutdown = async () => {};

  const d = new Daemon({ manager: stub, port: PORT + 7 });
  await d.start();
  try {
    const base = `http://127.0.0.1:${PORT + 7}`;
    const body = await (await fetch(base + "/widget.js")).text();
    assert.match(body, /disabled via \.sidebranch\.json/);
    assert.ok(!body.includes("__sidebranchStart"));

    const hs = await (await fetch(base + "/handshake")).json();
    assert.equal(hs.widget, false);
  } finally {
    await d.stop();
  }
});

test("GET /handshake is still behind the loopback gate", async () => {
  // It hands out the session token, so every gate that protects /widget.js
  // must protect this too. As above, fetch() refuses to spoof Host, so the
  // DNS-rebinding shape has to go through node:http.
  const { default: http } = await import("node:http");
  const rebound = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/handshake", headers: { Host: "evil.example" } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(rebound, 403, "a hostile Host header must not receive a token");

  const crossOrigin = await fetch(BASE + "/handshake", { headers: { Origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403, "a remote page must not receive a token");

  // A loopback page — the extension's content script is exactly this — passes.
  const loopback = await fetch(BASE + "/handshake", { headers: { Origin: "http://localhost:5173" } });
  assert.equal(loopback.status, 200);
  assert.equal(loopback.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

test("the bundled font serves as a valid, hard-cached woff2 the assets point at", async () => {
  const res = await fetch(BASE + "/geist-pixel.woff2");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "font/woff2");
  // No token and no per-run state in this file, unlike widget.js/shell.
  assert.match(res.headers.get("cache-control"), /immutable/);

  // Actually a woff2, not a mislabeled ttf: the container's magic number.
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString("latin1"), "wOF2");

  // Both assets must reference the route that exists. A stale ".ttf" URL
  // here fails silently in a browser (the font just never loads and the
  // mono fallback takes over), so assert it rather than eyeballing it.
  const w = await (await fetch(BASE + "/widget.js")).text();
  const sh = await (await fetch(BASE + "/shell")).text();
  for (const src of [w, sh]) {
    assert.ok(src.includes("/geist-pixel.woff2"));
    assert.ok(!src.includes("geist-pixel.ttf"));
  }
});

test("full loop: two panes on two branches, both actually serving", async () => {
  const a = await api("/api/pane", { method: "POST", body: { pane: "a", branch: "main" } });
  assert.equal(a.status, 200);
  const paneA = await a.json();
  assert.equal(paneA.status, "ready");

  const b = await api("/api/pane", { method: "POST", body: { pane: "b", branch: "pr/button-color" } });
  assert.equal(b.status, 200);
  const paneB = await b.json();
  assert.equal(paneB.status, "ready");
  assert.notEqual(paneA.port, paneB.port);

  const htmlA = await (await fetch(`http://127.0.0.1:${paneA.port}/index.html`)).text();
  const htmlB = await (await fetch(`http://127.0.0.1:${paneB.port}/index.html`)).text();
  assert.match(htmlA, /MAIN/);
  assert.match(htmlB, /PR/);

  // Switch pane A to the PR branch; server survives, content updates.
  const a2 = await api("/api/pane", { method: "POST", body: { pane: "a", branch: "pr/button-color" } });
  assert.equal(a2.status, 200);
  const htmlA2 = await (await fetch(`http://127.0.0.1:${paneA.port}/index.html`)).text();
  assert.match(htmlA2, /PR/);

  // The user's own working tree never moved.
  const { stdout } = await git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  assert.equal(stdout.trim(), "main");
});

test("a failing install surfaces a diagnosable error and a full log via the API", async () => {
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "sidebranch-e2e-log-"));
  const repo2 = path.join(tmp2, "app");
  const priorHome = process.env.SIDEBRANCH_HOME;
  process.env.SIDEBRANCH_HOME = path.join(tmp2, "home");
  try {
    await fs.mkdir(repo2);
    await git(repo2, "init", "-b", "main");
    await git(repo2, "config", "user.email", "t@example.com");
    await git(repo2, "config", "user.name", "Test");
    await fs.writeFile(path.join(repo2, "index.html"), "<h1>MAIN</h1>\n");
    // A stand-in "lockfile" so the install step actually runs.
    await fs.writeFile(path.join(repo2, "package-lock.json"), "{}");
    // A "package manager" that fails loudly, the way an expired private
    // registry token or a missing permission would in the real app.
    await fs.writeFile(
      path.join(repo2, "fail-install.js"),
      "console.error('npm ERR! code E401\\nnpm ERR! Unable to authenticate, need: Basic'); process.exit(1);"
    );
    await git(repo2, "add", ".");
    await git(repo2, "commit", "-m", "main");

    const PORT2 = 4599;
    const config2 = normalize({
      dev: "python3 -m http.server {port} --bind 127.0.0.1",
      install: `${process.execPath} fail-install.js`,
      basePort: 4570,
    });
    const manager2 = new Manager({ repoRoot: repo2, config: config2 });
    const daemon2 = new Daemon({ manager: manager2, port: PORT2 });
    await daemon2.start();
    const token2 = daemon2.token;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const api2 = (p, opts = {}) =>
      fetch(BASE2 + p, {
        ...opts,
        headers: { Authorization: `Bearer ${token2}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      });

    try {
      // Unknown pane: 404, not a guess.
      assert.equal((await api2("/api/pane/a/log")).status, 404);

      const res = await api2("/api/pane", { method: "POST", body: JSON.stringify({ pane: "a", branch: "main" }) });
      assert.equal(res.status, 500);
      const body = await res.json();
      // The final error message alone is now diagnosable, not just "exited with code 1".
      assert.match(body.error, /exited with code 1/);
      assert.match(body.error, /E401/);
      assert.match(body.error, /Unable to authenticate/);

      // And the full, real-newlines log is available without re-running the
      // install command by hand.
      const logRes = await api2("/api/pane/a/log");
      assert.equal(logRes.status, 200);
      const log = await logRes.json();
      assert.equal(log.status, "error");
      assert.match(log.install, /npm ERR! code E401/);
      assert.match(log.install, /npm ERR! Unable to authenticate, need: Basic/);
    } finally {
      await daemon2.stop();
    }
  } finally {
    if (priorHome === undefined) delete process.env.SIDEBRANCH_HOME;
    else process.env.SIDEBRANCH_HOME = priorHome;
    await fs.rm(tmp2, { recursive: true, force: true });
  }
});
