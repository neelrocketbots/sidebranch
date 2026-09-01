import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { DevServer, allocatePort, probeFraming, readFramingHeaders } from "../src/processes.js";

/** GET a small response body over loopback. */
function getBody(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

test("DevServer injects config env into the child and PORT always wins", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-proc-"));
  // A dev server that reports back the two env vars we care about, so the test
  // can prove (a) config env reached the child and (b) sidebranch's PORT beat
  // the config's attempt to override it.
  await fs.writeFile(
    path.join(dir, "server.js"),
    `require("http")
      .createServer((_q, r) =>
        r.end(process.env.MY_APP_VAR + "|" + process.env.PORT))
      .listen(process.env.PORT, "127.0.0.1");`,
  );

  const port = await allocatePort(4610);
  const server = new DevServer({
    command: "node server.js",
    cwd: dir,
    port,
    env: {
      MY_APP_VAR: "from-config",
      PORT: "1", // reserved: normalizeEnv would strip this, and even raw it must lose
    },
  });

  try {
    await server.start();
    const body = await getBody(port);
    assert.equal(body, `from-config|${port}`);
  } finally {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("DevServer with an empty env behaves exactly as before", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-proc-"));
  await fs.writeFile(
    path.join(dir, "server.js"),
    `require("http")
      .createServer((_q, r) => r.end("ok:" + process.env.PORT))
      .listen(process.env.PORT, "127.0.0.1");`,
  );

  const port = await allocatePort(4620);
  const server = new DevServer({ command: "node server.js", cwd: dir, port });

  try {
    await server.start();
    assert.equal(await getBody(port), `ok:${port}`);
  } finally {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * The compare view frames panes from the daemon's origin, which is a different
 * port and therefore a different origin. An app that refuses framing turns the
 * shell into a blank rectangle with the explanation trapped in a console the
 * shell can't read, so the daemon looks for it and the shell says so instead.
 */
test("framing headers are read the way a browser would treat them", () => {
  const D = 49400;
  const blocked = (h) => readFramingHeaders(h, D).blocked;

  assert.equal(blocked({}), false);
  assert.equal(blocked({ "x-frame-options": "SAMEORIGIN" }), true);
  assert.equal(blocked({ "x-frame-options": "sameorigin" }), true);
  assert.equal(blocked({ "x-frame-options": "DENY" }), true);
  // ALLOW-FROM is dead in every current browser; not our job to honor it.
  assert.equal(blocked({ "x-frame-options": "ALLOW-FROM http://localhost:49400" }), false);

  assert.equal(blocked({ "content-security-policy": "frame-ancestors 'none'" }), true);
  assert.equal(blocked({ "content-security-policy": "frame-ancestors 'self'" }), true);
  assert.equal(blocked({ "content-security-policy": "frame-ancestors *" }), false);
  assert.equal(blocked({ "content-security-policy": `frame-ancestors http://localhost:${D}` }), false);
  assert.equal(blocked({ "content-security-policy": "frame-ancestors http://localhost:*" }), false);
  // A frame-ancestors naming somebody else's port is still a refusal for us.
  assert.equal(blocked({ "content-security-policy": "frame-ancestors http://localhost:3000" }), true);
  // Other directives must not be mistaken for frame-ancestors.
  assert.equal(blocked({ "content-security-policy": "default-src 'self'; img-src *" }), false);

  const verdict = readFramingHeaders({ "x-frame-options": "SAMEORIGIN" }, D);
  assert.equal(verdict.header, "X-Frame-Options");
  assert.equal(verdict.value, "SAMEORIGIN");
});

test("probeFraming reports on a live server and never throws", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "X-Frame-Options": "SAMEORIGIN", "Content-Type": "text/html" });
    res.end("<!doctype html>hi");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const verdict = await probeFraming({ port, daemonPort: 49400 });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.header, "X-Frame-Options");
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Nothing listening: unknown, not "blocked". A dead server is a different
  // failure and already has its own reporting.
  const dead = await probeFraming({ port: 49999, daemonPort: 49400 });
  assert.equal(dead, null);
});
