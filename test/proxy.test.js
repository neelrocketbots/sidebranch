import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { FrameProxy, stripFramingHeaders } from "../src/proxy.js";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function startPair(handler) {
  const target = await listen(handler);
  const proxy = await new FrameProxy({ port: 0, targetPort: target.address().port }).start();
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  const close = async () => { await proxy.stop(); await new Promise((r) => target.close(r)); };
  return { base, proxy, target, close };
}

test("stripFramingHeaders removes exactly the two framing headers", () => {
  const { headers, removed } = stripFramingHeaders({
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src *",
    "set-cookie": ["a=1", "b=2"],
    "content-type": "text/html",
  });
  assert.equal(headers["x-frame-options"], undefined);
  assert.equal(headers["content-security-policy"], "default-src 'self'; img-src *");
  assert.deepEqual(headers["set-cookie"], ["a=1", "b=2"]);
  assert.deepEqual(removed, ["x-frame-options", "content-security-policy frame-ancestors"]);

  const untouched = stripFramingHeaders({ "content-security-policy": "default-src 'self'" });
  assert.equal(untouched.headers["content-security-policy"], "default-src 'self'");
  assert.deepEqual(untouched.removed, []);

  const only = stripFramingHeaders({ "content-security-policy": "frame-ancestors 'self'" });
  assert.equal(only.headers["content-security-policy"], undefined);
});

test("responses pass through byte-identical apart from the framing headers", async () => {
  const body = "x".repeat(100_000) + "— final byte";
  const { base, close } = await startPair((req, res) => {
    res.writeHead(200, {
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Custom": "kept",
    });
    res.end(body);
  });
  try {
    const res = await fetch(base + "/page");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
    assert.equal(res.headers.get("x-frame-options"), null);
    assert.equal(res.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(res.headers.get("x-custom"), "kept");
    assert.equal(res.headers.get("sidebranch-removed-headers"), "x-frame-options, content-security-policy frame-ancestors");
  } finally { await close(); }
});

test("no marker header when nothing was removed", async () => {
  const { base, close } = await startPair((req, res) => res.writeHead(204).end());
  try {
    const res = await fetch(base + "/");
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("sidebranch-removed-headers"), null);
  } finally { await close(); }
});

test("request method, path, and body reach the target", async () => {
  let seen = null;
  const { base, close } = await startPair((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { seen = { method: req.method, url: req.url, data }; res.end("ok"); });
  });
  try {
    await fetch(base + "/api/pane?x=1", { method: "POST", body: '{"a":1}' });
    assert.deepEqual(seen, { method: "POST", url: "/api/pane?x=1", data: '{"a":1}' });
  } finally { await close(); }
});

// fetch() refuses to override Host, so the rebinding case speaks raw http.
function rawGet(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the gate rejects bad Hosts and cross-site requests, and binds loopback", async () => {
  const { base, proxy, close } = await startPair((req, res) => res.end("secret"));
  const port = proxy.server.address().port;
  try {
    assert.equal(proxy.server.address().address, "127.0.0.1");

    // DNS rebinding: evil.example resolving to 127.0.0.1 must die at the gate.
    assert.equal(await rawGet(port, { Host: "evil.example" }), 403);

    // A remote page framing the view port announces itself; the stripped
    // header was the defense against exactly this, so the proxy takes over.
    const crossSite = await fetch(base + "/", { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);

    for (const site of ["same-origin", "same-site", "none"]) {
      const ok = await fetch(base + "/", { headers: { "Sec-Fetch-Site": site } });
      assert.equal(ok.status, 200, `Sec-Fetch-Site: ${site} must pass`);
    }
  } finally { await close(); }
});

test("a dead target answers 502, not a hang", async () => {
  const { base, target, close } = await startPair((req, res) => res.end("up"));
  try {
    await new Promise((r) => target.close(r));
    const res = await fetch(base + "/");
    assert.equal(res.status, 502);
  } finally { await close().catch(() => {}); }
});

test("websocket upgrades splice through, with the gate applied", async () => {
  const target = await listen((req, res) => res.end());
  target.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
    // http.Server sockets allow half-open; a real ws server closes on FIN.
    socket.on("end", () => socket.destroy());
    socket.on("error", () => socket.destroy());
  });
  const proxy = await new FrameProxy({ port: 0, targetPort: target.address().port }).start();
  const port = proxy.server.address().port;

  const roundtrip = (headers) => new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET /hmr HTTP/1.1\r\n${headers}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (buf.includes("101") && !buf.includes("echo!")) sock.write("echo!");
      if (buf.includes("echo!") || buf.includes("403")) { sock.destroy(); resolve(buf); }
    });
    sock.on("error", () => resolve(buf));
    sock.on("close", () => resolve(buf));
  });

  try {
    const ok = await roundtrip(`Host: localhost:${port}\r\n`);
    assert.match(ok, /101 Switching Protocols/);
    assert.match(ok, /echo!/);

    assert.match(await roundtrip("Host: evil.example\r\n"), /403/);
    assert.match(await roundtrip(`Host: localhost:${port}\r\nSec-Fetch-Site: cross-site\r\n`), /403/);
  } finally {
    await proxy.stop();
    await new Promise((r) => target.close(r));
  }
});
