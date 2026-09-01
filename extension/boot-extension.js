/**
 * boot-extension.js — the browser extension's credential delivery.
 *
 * The mirror image of `boot-tag.js`. That file receives a token substituted
 * into it by the daemon at response time; this one cannot, because Manifest
 * V3 forbids executing remotely-fetched code. So the extension ships
 * `widget-core.js` verbatim in its own package (loaded as the content script
 * immediately before this file, into the same isolated world, which is how
 * `globalThis.__sidebranchStart` is already defined by the time this runs)
 * and asks the daemon for a token over HTTP instead.
 *
 * Every request in this file is issued from the content script, never from a
 * background service worker, and that is not a style preference — see the
 * note on `probe()` below.
 */
(() => {
  "use strict";

  /**
   * The /api/* contract version this build of the extension understands.
   * MUST equal `API_VERSION` in `src/daemon.js`; a test asserts it does.
   *
   * The extension updates on the Web Store's clock and the daemon on npm's,
   * so they will drift. On a mismatch the widget stays invisible and says
   * which side is behind — half-working against a daemon whose responses you
   * don't understand is worse than not rendering.
   */
  const API_VERSION = 1;

  const DEFAULT_PORT = 49400;
  const PORT_KEY = "port";

  const start = globalThis.__sidebranchStart;

  /**
   * The daemon's port is a CLI flag (`sidebranch start --port`), and nothing
   * in the browser can discover it. Default to 49400 and let the options page
   * store an override. Deliberately NOT a port scan: probing a range from
   * every localhost page you open is noisy, slow, and reads to a store
   * reviewer exactly like the thing it isn't.
   */
  async function readPort() {
    try {
      const stored = await chrome.storage.sync.get(PORT_KEY);
      const n = Number.parseInt(stored?.[PORT_KEY], 10);
      if (Number.isInteger(n) && n >= 1024 && n <= 65000) return n;
    } catch { /* storage unavailable — fall through to the default */ }
    return DEFAULT_PORT;
  }

  /**
   * The one hard architectural rule of this extension: all daemon traffic
   * goes through the content script.
   *
   * A content script's fetch carries the *page's* origin
   * (`http://localhost:5173`), which the daemon's Origin allowlist already
   * admits. A service worker's would carry `chrome-extension://<id>`, which
   * the daemon rejects on protocol — and "fixing" that by allowlisting an
   * extension origin would admit the first non-loopback origin in this
   * tool's history. So there is no service worker in this extension at all,
   * and the options page's connection test is routed back through here
   * (see the message listener at the bottom) rather than fetching for itself.
   */
  async function probe(port, path) {
    const res = await fetch(`http://localhost:${port}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Read the bundled font as binary rather than handing the widget a URL.
   *
   * The tag channel can afford a URL: a page that would block the font has
   * already blocked the <script> that asks for it. The extension runs on
   * pages that never opted into anything, and a FontFace built from a URL is
   * fetched by the *page's* document under the *page's* `font-src` CSP — so
   * on a strict-CSP dev server the widget would render in fallback mono for
   * no reason the user could act on. Binary data performs no fetch and no CSP
   * applies. The `web_accessible_resources` entry in the manifest is what
   * makes this URL readable at all.
   */
  async function loadFontSource() {
    try {
      const res = await fetch(chrome.runtime.getURL("geist-pixel.woff2"));
      return await res.arrayBuffer();
    } catch {
      return undefined;
    }
  }

  /**
   * Both channels can be live on the same page — a project with the script
   * tag still in its HTML, opened by someone who also installed the
   * extension. Core's own `window.__sidebranchLoaded` guard can't catch that:
   * the content script runs in an isolated world with its own `window`, so
   * each channel would see a clean slate and mount its own pill.
   *
   * The DOM is the one thing the two worlds share, so the host element is the
   * only usable "already here" signal. This is a best-effort check, not a
   * lock: if the tag's script happens to load after this runs, both mount and
   * the user sees two pills until reload. Losing that race is a cosmetic
   * annoyance in a setup nobody needs — the extension makes the tag redundant.
   */
  function alreadyMounted() {
    return document.querySelector("sidebranch-widget") !== null;
  }

  /**
   * The daemon serves its own pages — `/shell` above all — on loopback, so
   * they match the content script's patterns like any dev server. The widget
   * has no business there: the compare view *is* sidebranch, and a pill
   * floating over it offering to switch branches is both redundant and
   * confusing. The daemon's port is the reliable tell, since nothing else can
   * be listening on it.
   */
  function isDaemonPage(daemonPort) {
    return Number(location.port) === Number(daemonPort);
  }

  async function boot({ force = false } = {}) {
    if (typeof start !== "function") return;
    if (!force && alreadyMounted()) return;

    const port = await readPort();

    let hs;
    try {
      hs = await probe(port, "/handshake");
    } catch {
      // Daemon not running, or running on another port. Stay invisible: the
      // page is visually untouched, exactly as with the tag channel.
      return;
    }

    if (hs.apiVersion !== API_VERSION) {
      console.warn(
        `[sidebranch] extension speaks API v${API_VERSION}, daemon ${hs.version} speaks v${hs.apiVersion}. ` +
        (hs.apiVersion > API_VERSION
          ? "Update the extension from the Chrome Web Store."
          : "Update the npm package (npm i -g sidebranch@latest).") +
        " The widget will not render until they match."
      );
      return;
    }

    // `"widget": false` in .sidebranch.json. The tag channel honors it by
    // serving a no-op body; the extension ships the widget itself, so the
    // handshake has to tell it and it has to obey.
    if (hs.widget !== true) return;
    if (isDaemonPage(hs.port)) return;

    start({
      token: hs.token,
      port: hs.port,
      fontSource: await loadFontSource(),
      channel: "extension",
      force,
    });
  }

  /**
   * `start()` returns before the widget appears — it probes the daemon first
   * and mounts in a `.then()`. Reporting "shown" the instant boot resolves is
   * therefore a guess, and a wrong one often enough to matter. Wait for the
   * element so the popup only ever claims what happened.
   */
  function waitForMount(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        if (alreadyMounted()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(check, 60);
      };
      check();
    });
  }

  /**
   * The options page has no way to test a connection itself — its fetches
   * would carry `chrome-extension://<id>` as Origin and the daemon would
   * reject them (see `probe()`). So it asks a content script on a loopback
   * tab to make the request on its behalf and report back.
   *
   * Registered unconditionally, before and regardless of `boot()`'s outcome:
   * the case the user most needs to test is the one where booting just failed.
   */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "sidebranch:probe") {
      readPort()
        .then((port) => probe(port, "/handshake").then((hs) => ({ ok: true, port, hs })))
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }
    /**
     * "Hide for this session" is sessionStorage, which is per tab — so once
     * hidden, the only way back used to be a new tab, which is a dead end the
     * user has no way to guess at. The popup calls this to undo it in place.
     */
    if (msg?.type === "sidebranch:show") {
      boot({ force: true })
        .then(waitForMount)
        .then((mounted) => sendResponse({ ok: true, mounted }))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }
    return false;
  });

  boot();
})();
