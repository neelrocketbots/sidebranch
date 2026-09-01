/**
 * popup.js — the toolbar icon's panel.
 *
 * It exists for one recovery case: "Hide for this session" writes to
 * sessionStorage, which is scoped to the tab, so a reviewer who hides the
 * widget has no way back inside that tab — the widget they would click is the
 * thing they just hid. This is the way back.
 *
 * Like the options page, it performs no daemon requests of its own; an
 * extension page's fetch carries a `chrome-extension://` origin the daemon
 * rejects. Everything goes through the content script on the active tab.
 */
(() => {
  "use strict";

  const statusEl = document.getElementById("status");
  const showBtn = document.getElementById("show");

  const say = (text, kind) => {
    statusEl.textContent = text;
    statusEl.className = kind ? `status ${kind}` : "status";
  };

  const activeTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  };

  const isLoopback = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    } catch { return false; }
  };

  /**
   * `sendMessage` rejects when no content script is listening — which is the
   * normal state for a tab that was already open when the extension was
   * installed or updated, not an error worth alarming anybody about.
   */
  const ask = async (tabId, type) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { type });
    } catch {
      return null;
    }
  };

  async function init() {
    const tab = await activeTab();
    if (!tab || !isLoopback(tab.url ?? "")) {
      showBtn.disabled = true;
      say("This tab isn't a localhost page. Open your dev server, then click here again.");
      return;
    }

    const reply = await ask(tab.id, "sidebranch:probe");
    if (reply === null) {
      say("This tab was loaded before the extension. Reload it to get the widget.", "err");
      return;
    }
    if (!reply.ok) {
      say(`No daemon on port ${await configuredPort()}. Run "sidebranch start" in the project, then reload this tab.`, "err");
      return;
    }
    say(`Daemon ${reply.hs.version} on port ${reply.port}.`, "ok");
  }

  const configuredPort = async () => {
    try {
      const stored = await chrome.storage.sync.get("port");
      return Number.parseInt(stored?.port, 10) || 49400;
    } catch { return 49400; }
  };

  showBtn.addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) return;
    const reply = await ask(tab.id, "sidebranch:show");
    if (reply?.mounted) {
      say("Widget shown.", "ok");
      // Nothing left to look at in here — the thing they asked for is on the
      // page behind this panel.
      setTimeout(() => window.close(), 500);
      return;
    }
    if (reply === null) say("This tab has no sidebranch content script. Reload it.", "err");
    else say("Couldn't show it — is the daemon running? See the message above.", "err");
  });

  document.getElementById("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  init();
})();
