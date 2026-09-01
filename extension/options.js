/**
 * options.js — the port override, and a connection test that has to be
 * performed by somebody else.
 *
 * MV3 forbids inline script in extension pages, hence a separate file for
 * what is otherwise thirty lines of DOM wiring.
 */
(() => {
  "use strict";

  const DEFAULT_PORT = 49400;
  const PORT_KEY = "port";
  const LOOPBACK_TABS = { url: ["http://localhost/*", "http://127.0.0.1/*"] };

  const portInput = document.getElementById("port");
  const statusEl = document.getElementById("status");

  const say = (text, kind) => {
    statusEl.textContent = text;
    statusEl.className = kind ? `status ${kind}` : "status";
  };

  chrome.storage.sync.get(PORT_KEY).then((stored) => {
    const n = Number.parseInt(stored?.[PORT_KEY], 10);
    if (Number.isInteger(n)) portInput.value = String(n);
  }).catch(() => { /* leave the placeholder showing the default */ });

  document.getElementById("save").addEventListener("click", async () => {
    const raw = portInput.value.trim();
    // Empty means "use the default" — store nothing rather than storing 49400,
    // so a later change to the default is picked up instead of pinned.
    if (raw === "") {
      await chrome.storage.sync.remove(PORT_KEY);
      say(`Cleared. Using the default port ${DEFAULT_PORT}.`, "ok");
      return;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1024 || n > 65000) {
      say("Port must be a whole number between 1024 and 65000.", "err");
      return;
    }
    await chrome.storage.sync.set({ [PORT_KEY]: n });
    say(`Saved. Reload your app tab to use port ${n}.`, "ok");
  });

  /**
   * The test cannot be run from this page.
   *
   * A fetch from an extension page carries `Origin: chrome-extension://<id>`,
   * which the daemon rejects on protocol — by design, and not something to
   * work around here. So find a loopback tab, ask its content script to do
   * the handshake with the page's own origin, and report what it saw. That is
   * also a strictly better test: it exercises the exact request path the
   * widget uses, rather than a different one that happens to be convenient.
   *
   * `chrome.tabs.query` can filter and read these URLs without the broad
   * "tabs" permission because the manifest already holds host permissions for
   * exactly these two origins.
   */
  document.getElementById("test").addEventListener("click", async () => {
    say("Testing…");
    let tabs = [];
    try {
      tabs = await chrome.tabs.query(LOOPBACK_TABS);
    } catch { /* handled as "none found" below */ }

    if (tabs.length === 0) {
      say("Open a tab on http://localhost (your dev server) and try again — the test runs from that page, not from this one.", "err");
      return;
    }

    for (const tab of tabs) {
      let reply;
      try {
        reply = await chrome.tabs.sendMessage(tab.id, { type: "sidebranch:probe" });
      } catch {
        // No content script in that tab yet (loaded before the extension was
        // installed or updated). Try the next one before giving up.
        continue;
      }
      if (reply?.ok) {
        const hs = reply.hs;
        say(
          `Connected on port ${reply.port} — sidebranch ${hs.version}, API v${hs.apiVersion}` +
          (hs.widget === true ? "." : `. Note: this project sets "widget": false, so the widget stays hidden.`),
          "ok"
        );
      } else {
        say(
          `No daemon answered on the configured port from ${new URL(tab.url).host}. ` +
          `Is it running? Start it with "sidebranch start" in the project. (${reply?.error ?? "no response"})`,
          "err"
        );
      }
      return;
    }

    say("Found a localhost tab, but it has no sidebranch content script yet. Reload that tab and try again.", "err");
  });
})();
