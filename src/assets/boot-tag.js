/**
 * boot-tag.js — the script-tag channel's credential delivery.
 *
 * Appended to `widget-core.js` by `Daemon.serveWidget()`, which substitutes
 * the two placeholders below at response time. This is the original delivery
 * mechanism, unchanged in behavior: the token arrives baked into the response
 * body, and lives only in the closure `__sidebranchStart` opens for it.
 *
 * The extension's boot is the other half of this pair. It cannot look like
 * this file — MV3 bans running remotely-fetched code, so it must ask for the
 * token over HTTP instead of receiving a rendered template.
 */
(() => {
  "use strict";
  const start = globalThis.__sidebranchStart;
  // Defensive: if core failed to parse, do nothing rather than throwing an
  // uncaught error into someone else's dev console.
  if (typeof start !== "function") return;
  start({ token: "__SIDEBRANCH_TOKEN__", port: "__SIDEBRANCH_PORT__" });
})();
