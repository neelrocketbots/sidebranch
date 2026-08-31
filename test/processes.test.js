import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { DevServer, allocatePort } from "../src/processes.js";

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
