import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLoopbackAddress, isLoopbackHostname, isAllowedHostHeader, isAllowedOrigin,
  isSafeRefName, generateToken, tokenMatches, isValidPort,
} from "../src/security.js";

test("loopback socket addresses", () => {
  assert.ok(isLoopbackAddress("127.0.0.1"));
  assert.ok(isLoopbackAddress("127.0.0.53"));
  assert.ok(isLoopbackAddress("::1"));
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
  assert.ok(!isLoopbackAddress("192.168.1.5"));
  assert.ok(!isLoopbackAddress("10.0.0.1"));
  assert.ok(!isLoopbackAddress("::ffff:192.168.1.5"));
  assert.ok(!isLoopbackAddress(""));
  assert.ok(!isLoopbackAddress(undefined));
});

test("Host header validation blocks DNS rebinding", () => {
  assert.ok(isAllowedHostHeader("localhost:4400"));
  assert.ok(isAllowedHostHeader("127.0.0.1:4400"));
  assert.ok(isAllowedHostHeader("[::1]:4400"));
  assert.ok(isAllowedHostHeader("localhost"));
  // The rebinding case: attacker's DNS points evil.example at 127.0.0.1.
  // The socket is loopback but the Host header is not — must be rejected.
  assert.ok(!isAllowedHostHeader("evil.example:4400"));
  assert.ok(!isAllowedHostHeader("localhost.evil.example"));
  assert.ok(!isAllowedHostHeader("mylocalhost:4400"));
  assert.ok(!isAllowedHostHeader(""));
  assert.ok(!isAllowedHostHeader(undefined));
});

test("origin allowlist admits only loopback web origins", () => {
  assert.ok(isAllowedOrigin("http://localhost:5173"));
  assert.ok(isAllowedOrigin("http://127.0.0.1:3000"));
  assert.ok(isAllowedOrigin("https://localhost:8443"));
  assert.ok(isAllowedOrigin(undefined));   // non-browser clients; token still gates
  assert.ok(!isAllowedOrigin("null"));      // sandboxed iframe / file://
  assert.ok(!isAllowedOrigin("https://evil.example"));
  assert.ok(!isAllowedOrigin("http://localhost.evil.example"));
  assert.ok(!isAllowedOrigin("chrome-extension://abc"));
  assert.ok(!isAllowedOrigin("http://192.168.1.20:5173"));
});

test("ref name validation refuses injection-shaped names", () => {
  assert.ok(isSafeRefName("main"));
  assert.ok(isSafeRefName("feature/login-form"));
  assert.ok(isSafeRefName("release/v1.2.3"));
  assert.ok(isSafeRefName("user/JIRA-123_fix"));

  const bad = [
    "-D", "--force", "branch name", "a;rm -rf /", "a`id`", "a$(id)",
    "a|b", "a&b", "a>b", "a<b", "a'b", 'a"b', "..", "a..b", "a@{1}",
    "refs/../../etc", "a\nb", "a\tb", "", "-", ".hidden", "a.", "a//b",
    "HEAD~1", "branch^", "a:b", "a?b", "a*b", "a[b",
  ];
  for (const name of bad) assert.ok(!isSafeRefName(name), `should reject ${JSON.stringify(name)}`);
});

test("tokens are random, compared in constant time, and length-checked", () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert.equal(t1.length, 64);
  assert.notEqual(t1, t2);
  assert.ok(tokenMatches(t1, t1));
  assert.ok(!tokenMatches(t1, t2));
  assert.ok(!tokenMatches(t1, t1.slice(0, 63)));
  assert.ok(!tokenMatches(t1, ""));
  assert.ok(!tokenMatches(t1, null));
  assert.ok(!tokenMatches(t1, undefined));
});

test("port validation", () => {
  assert.ok(isValidPort(4400));
  assert.ok(!isValidPort(0));
  assert.ok(!isValidPort(65536));
  assert.ok(!isValidPort("4400"));
  assert.ok(!isValidPort(44.5));
});
