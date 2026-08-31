import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lockfileHash, splitCommand, runInstall, pushRing, tailText } from "../src/install.js";
import { normalize } from "../src/config.js";

test("lockfileHash changes only when a lockfile changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-lock-"));
  try {
    const h0 = await lockfileHash(dir);
    assert.equal(h0, "no-lockfiles");

    await fs.writeFile(path.join(dir, "package-lock.json"), '{"v":1}');
    const h1 = await lockfileHash(dir);
    assert.notEqual(h1, h0);

    // Unrelated file changes do not affect the hash
    await fs.writeFile(path.join(dir, "app.js"), "console.log(1)");
    assert.equal(await lockfileHash(dir), h1);

    // Lockfile content change does
    await fs.writeFile(path.join(dir, "package-lock.json"), '{"v":2}');
    const h2 = await lockfileHash(dir);
    assert.notEqual(h2, h1);

    // A second manifest type contributes too (polyglot repos)
    await fs.writeFile(path.join(dir, "requirements.txt"), "flask==3.0.0");
    assert.notEqual(await lockfileHash(dir), h2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("splitCommand: word splitting with quotes, never a shell", () => {
  assert.deepEqual(splitCommand("npm run dev"), ["npm", "run", "dev"]);
  assert.deepEqual(splitCommand('node server.js --name "My App"'), ["node", "server.js", "--name", "My App"]);
  assert.deepEqual(splitCommand("npx vite --port {port}"), ["npx", "vite", "--port", "{port}"]);
  assert.deepEqual(splitCommand(""), []);
  // Shell metacharacters are inert — they become literal argv entries,
  // they are never interpreted.
  assert.deepEqual(splitCommand("echo hi && rm -rf /"), ["echo", "hi", "&&", "rm", "-rf", "/"]);
});

test("pushRing: bounded FIFO, drops oldest once over max", () => {
  const ring = [];
  for (let i = 0; i < 5; i++) pushRing(ring, String(i), 3);
  assert.deepEqual(ring, ["2", "3", "4"]);
});

test("tailText: collapses newlines, trims, and caps from the end", () => {
  assert.equal(tailText([]), "");
  assert.equal(tailText(["  hello \n world  "]), "hello › world");
  const long = "a".repeat(50) + "\n" + "b".repeat(50);
  const tail = tailText([long], 20);
  assert.ok(tail.length <= 20);
  assert.ok(tail.endsWith("b".repeat(20)) || /b+$/.test(tail));
});

test("runInstall: a failing command's error message includes a tail of its own output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-install-"));
  try {
    await fs.writeFile(
      path.join(dir, "fail.js"),
      "console.error('npm ERR! code E401\\nnpm ERR! Unable to authenticate'); process.exit(1);"
    );
    await assert.rejects(
      runInstall(dir, `${process.execPath} fail.js`),
      (err) => {
        assert.match(err.message, /exited with code 1/);
        assert.match(err.message, /E401/);
        assert.match(err.message, /Unable to authenticate/);
        return true;
      }
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runInstall: an externally supplied ring accumulates the same raw output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-install-"));
  try {
    await fs.writeFile(
      path.join(dir, "ok.js"),
      "process.stdout.write('installing…\\n'); process.exit(0);"
    );
    const ring = [];
    const result = await runInstall(dir, `${process.execPath} ok.js`, { ring });
    assert.deepEqual(result, { skipped: false });
    assert.ok(ring.join("").includes("installing…"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("config normalization clamps and defaults", () => {
  const cfg = normalize({ dev: "npm run dev", panes: 99, basePort: 10, ready: { path: "nope" } });
  assert.equal(cfg.panes, 4);
  assert.equal(cfg.basePort, 1024);
  assert.equal(cfg.ready.path, "/");
  assert.throws(() => normalize({ dev: "" }));
  const cfg2 = normalize({ copy: ["../../etc/passwd", "/abs", ".env"] });
  assert.deepEqual(cfg2.copy, [".env"]);
  // env defaults to an empty object when absent or malformed
  assert.deepEqual(normalize({ dev: "x" }).env, {});
  assert.deepEqual(normalize({ dev: "x", env: ["not", "a", "map"] }).env, {});
});

test("config env: keeps valid vars, drops unsafe ones, preserves empty string", () => {
  const cfg = normalize({
    dev: "x",
    env: {
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      GOOGLE_APPLICATION_CREDENTIALS: "", // empty string is a deliberate unset
      PORT: "9999",                       // reserved — must be dropped
      BROWSER: "firefox",                 // reserved — must be dropped
      "bad-name": "x",                    // not a POSIX env name — dropped
      "1LEADING": "x",                    // can't start with a digit — dropped
      COUNT: 42,                          // number coerced to string
      FLAG: true,                         // boolean coerced to string
      OBJ: { nope: 1 },                   // non-scalar — dropped
      NULLISH: null,                      // dropped
      HASNUL: "a" + String.fromCharCode(0) + "b", // NUL cannot go in env — dropped
    },
  });
  assert.deepEqual(cfg.env, {
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    COUNT: "42",
    FLAG: "true",
  });
});
