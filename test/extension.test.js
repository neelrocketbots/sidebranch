import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { API_VERSION } from "../src/daemon.js";

const ext = (p) => new URL(`../extension/${p}`, import.meta.url);
const src = (p) => new URL(`../src/assets/${p}`, import.meta.url);

const readManifest = async () => JSON.parse(await fs.readFile(ext("manifest.json"), "utf8"));

/**
 * The extension ships copies of three files from `src/assets/`, for the same
 * reason `site/` does: a build step would be the only alternative, and this
 * repo has no build step. The copies are safe exactly as long as something
 * fails loudly when they drift — that is this test.
 */
test("the extension's copies of the shared assets are byte-identical", async () => {
  for (const file of ["widget-core.js", "geist-pixel.woff2", "geist-pixel.LICENSE.txt"]) {
    const [a, b] = await Promise.all([fs.readFile(src(file)), fs.readFile(ext(file))]);
    assert.ok(a.equals(b), `extension/${file} has drifted from src/assets/${file} — re-copy it`);
  }
});

/**
 * The whole point of the core/boot split. A token baked into core would be a
 * secret published to the Chrome Web Store, and there is no way to unpublish
 * a build once it has shipped.
 */
test("the extension ships no credential", async () => {
  const files = ["widget-core.js", "boot-extension.js", "options.js", "options.html",
                 "popup.js", "popup.html", "manifest.json"];
  for (const file of files) {
    const body = await fs.readFile(ext(file), "utf8");
    assert.ok(!body.includes("__SIDEBRANCH_TOKEN__"), `${file} carries the token placeholder`);
    assert.ok(!/\b[a-f0-9]{64}\b/.test(body), `${file} contains something shaped like a session token`);
  }
});

/**
 * MV3 bans remotely-fetched code. The extension is rejected — or worse,
 * accepted and then pulled — if it evaluates anything it did not ship.
 */
test("the extension evaluates nothing it did not ship", async () => {
  for (const file of ["boot-extension.js", "options.js", "popup.js"]) {
    const body = await fs.readFile(ext(file), "utf8");
    assert.ok(!/\beval\s*\(/.test(body), `${file} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(body), `${file} uses new Function`);
    assert.ok(!/import\s*\(/.test(body), `${file} uses dynamic import`);
  }
  // MV3's extension-page CSP blocks inline script outright.
  for (const page of ["options.html", "popup.html"]) {
    const body = await fs.readFile(ext(page), "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(body), `${page} has an inline <script>`);
    assert.ok(!/<script[^>]+src=["']https?:/i.test(body), `${page} loads a remote script`);
  }
});

/**
 * The permission surface is the thing a store reviewer reads first and the
 * thing a user is asked to accept. Every widening below is a decision someone
 * should have to make deliberately.
 */
test("the manifest asks for loopback and nothing else", async () => {
  const m = await readManifest();
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ["storage"]);
  assert.deepEqual(m.host_permissions, ["http://localhost/*", "http://127.0.0.1/*"]);

  const patterns = [
    ...m.host_permissions,
    ...m.content_scripts.flatMap((c) => c.matches),
    ...m.web_accessible_resources.flatMap((r) => r.matches),
  ];
  for (const p of patterns) {
    assert.ok(!p.includes("<all_urls>"), `${p} is <all_urls>`);
    assert.match(p, /^http:\/\/(localhost|127\.0\.0\.1)\/\*$/, `${p} is not a loopback pattern`);
  }

  assert.ok(!("optional_permissions" in m));
  assert.ok(!("optional_host_permissions" in m));
  assert.ok(!("content_security_policy" in m), "the extension must not relax its own CSP");
});

/**
 * Not a style rule. A service worker's fetch carries `chrome-extension://<id>`
 * as its Origin, which the daemon rejects on protocol — and the only way to
 * make one work would be to allowlist the first non-loopback origin in this
 * tool's history. See SECURITY.md.
 */
test("the extension has no background service worker", async () => {
  const m = await readManifest();
  assert.ok(!("background" in m), "a background worker cannot legally talk to the daemon");
});

test("the content script loads core before the boot that calls it", async () => {
  const m = await readManifest();
  assert.equal(m.content_scripts.length, 1);
  assert.deepEqual(m.content_scripts[0].js, ["widget-core.js", "boot-extension.js"]);
});

/**
 * The font is loaded as binary and handed to FontFace, which is what keeps a
 * strict page CSP from silently downgrading the widget to fallback mono. That
 * only works if the file is reachable from the page's own tab.
 */
test("the font is a web-accessible resource and the widget can take it as data", async () => {
  const m = await readManifest();
  assert.deepEqual(m.web_accessible_resources[0].resources, ["geist-pixel.woff2"]);

  const core = await fs.readFile(src("widget-core.js"), "utf8");
  assert.match(core, /fontSource/, "core no longer accepts an injected font source");

  const boot = await fs.readFile(ext("boot-extension.js"), "utf8");
  assert.match(boot, /arrayBuffer\(\)/, "the boot no longer passes the font as binary");
  assert.match(boot, /chrome\.runtime\.getURL\("geist-pixel\.woff2"\)/);
});

/**
 * The two halves update on different clocks (Web Store vs npm) and will drift.
 * They may only drift in *version*, never in what the number means.
 */
test("the extension's API version matches the daemon's", async () => {
  const boot = await fs.readFile(ext("boot-extension.js"), "utf8");
  const declared = /const API_VERSION = (\d+);/.exec(boot);
  assert.ok(declared, "boot-extension.js declares no API_VERSION");
  assert.equal(
    Number(declared[1]), API_VERSION,
    "bump extension/boot-extension.js and src/daemon.js together, or every user sees the skew warning"
  );
});

test("every icon the manifest names exists and is a PNG", async () => {
  const m = await readManifest();
  const sizes = Object.keys(m.icons);
  assert.deepEqual(sizes, ["16", "32", "48", "128"]);
  for (const size of sizes) {
    const bytes = await fs.readFile(new URL(`../extension/${m.icons[size]}`, import.meta.url));
    assert.ok(
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `icon ${size} is not a PNG`
    );
  }
});

/**
 * `files` is a whitelist, so the extension is excluded by construction — but
 * the failure mode if that ever changes is publishing a second copy of the
 * widget to npm, where it would rot out of sync with the one people install.
 */
test("the extension is not part of the npm package", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(!pkg.files.includes("extension"));
  assert.ok(!pkg.files.includes("scripts"));
});

/**
 * The popup exists for one recovery case, and it is a real one: "Hide for this
 * session" is sessionStorage, so the widget a reviewer would click to undo it
 * is the widget they just hid. Without a way back the tab is a dead end.
 */
test("the popup can restore a hidden widget without a service worker", async () => {
  const m = await readManifest();
  assert.equal(m.action?.default_popup, "popup.html");
  assert.ok(!("background" in m), "the popup must not have introduced a worker");

  await fs.access(ext("popup.html"));
  const popup = await fs.readFile(ext("popup.js"), "utf8");
  // The popup must not fetch the daemon itself — same origin problem as the
  // options page. It only ever messages the content script.
  assert.ok(!/\bfetch\s*\(/.test(popup), "the popup fetches directly; it must go through the content script");
  assert.match(popup, /sidebranch:show/);

  const boot = await fs.readFile(ext("boot-extension.js"), "utf8");
  assert.match(boot, /sidebranch:show/);
  assert.match(boot, /force: true|force = false/);
});

/**
 * The compare view is served by the daemon on loopback, so it matches the
 * content script like any dev server. A pill floating over the compare view
 * offering to switch branches is redundant with the view it is sitting on.
 */
test("the widget is not injected into the daemon's own pages", async () => {
  const boot = await fs.readFile(ext("boot-extension.js"), "utf8");
  assert.match(boot, /isDaemonPage/);
  assert.match(boot, /Number\(location\.port\) === Number\(daemonPort\)/);
});

/**
 * The widget body cannot tell how it was delivered, and must not guess — the
 * setup instructions it shows would be wrong half the time if it did.
 */
test("each boot tells the widget which channel it is", async () => {
  const tag = await fs.readFile(new URL("../src/assets/boot-tag.js", import.meta.url), "utf8");
  assert.match(tag, /channel: "tag"/);
  const boot = await fs.readFile(ext("boot-extension.js"), "utf8");
  assert.match(boot, /channel: "extension"/);
});
