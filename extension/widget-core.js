/**
 * sidebranch widget (core) — the entire in-page UI, minus how it gets its
 * credentials. This file defines `globalThis.__sidebranchStart(options)` and
 * does nothing else on load; a *boot* file calls it.
 *
 * There are two boots, because there are two ways to deliver the widget:
 *
 *   - `boot-tag.js` — for `<script src="http://localhost:49400/widget.js">`.
 *     The daemon concatenates core + this boot and substitutes the token and
 *     port into it at response time, exactly as it always has.
 *   - the browser extension's content script — which cannot use a rendered
 *     template at all, because Manifest V3 forbids executing remotely-fetched
 *     code. It ships this file verbatim and calls the same entry point with a
 *     token it fetched from `GET /handshake` at runtime.
 *
 * Hence the split: one widget body, two credential sources, no forked code.
 * Nothing in here may assume which boot called it.
 *
 * Behavior contract:
 *   - Runs ONLY when the embedding page itself is served from loopback.
 *     Anywhere else (including production, if the tag ever ships) it does
 *     nothing: no network calls, no DOM, no globals. Inert by construction.
 *   - Renders nothing until the daemon has answered — if the daemon isn't
 *     running, the page is visually untouched.
 *   - The session token lives inside this closure. It is never written to
 *     storage, cookies, URLs, or the DOM.
 *   - One persistent pill element grows into a toolbar on click (no
 *     separate elements swapped in/out); Esc backs out one level at a time
 *     (flyout -> toolbar -> nothing); clicking outside collapses it.
 *     The "Hide for this session" toggle (in Settings) fades the whole
 *     widget out, then hides it for the tab's session (sessionStorage);
 *     corner position persists across sessions (localStorage).
 */
/* `??=` so that loading core twice in one context (a page with two script
 * tags, say) doesn't replace a definition the first load may already be
 * running from. Note the parameter is a plain identifier destructured in the
 * body rather than `({ token, port })`: a destructuring parameter list makes
 * the "use strict" directive below a SyntaxError. */
globalThis.__sidebranchStart ??= (options) => {
  "use strict";

  const { token, port, fontSource, channel = "tag", force = false } = options;

  // ---- hard gate: loopback pages only ------------------------------------
  // Kept here, not in the boots, so it protects both channels. The extension
  // only injects on loopback matches anyway; this is the belt to that braces.
  const h = location.hostname;
  const isLoop = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || /^127\./.test(h);
  if (!isLoop) return;
  if (window.__sidebranchLoaded) return;

  const TOKEN = token;
  const DAEMON = "http://localhost:" + port;
  const HIDE_KEY = "sidebranch:hidden";
  const POS_KEY = "sidebranch:position";

  /* "Hide for this session" is sessionStorage, so it is per tab and clears
   * itself when the tab closes. `force` is how it gets undone *without*
   * closing the tab: the extension's popup asks for a re-mount, we clear the
   * flag and carry on. The loaded-guard above is deliberately checked before
   * this and cleared by the hide handler, so a forced start after a hide sees
   * a clean slate while a forced start over a *live* widget still no-ops. */
  try {
    if (sessionStorage.getItem(HIDE_KEY) === "1") {
      if (!force) return;
      sessionStorage.removeItem(HIDE_KEY);
    }
  } catch { /* storage blocked — continue */ }

  window.__sidebranchLoaded = true;

  const POSITIONS = {
    br: "right:16px;bottom:16px;",
    bl: "left:16px;bottom:16px;",
    tr: "right:16px;top:16px;",
    tl: "left:16px;top:16px;",
  };
  let position = "br";
  try {
    const stored = localStorage.getItem(POS_KEY);
    if (stored && POSITIONS[stored]) position = stored;
  } catch { /* storage blocked — default position */ }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const api = async (p, opts = {}) => {
    const res = await fetch(DAEMON + p, {
      ...opts,
      headers: {
        Authorization: "Bearer " + TOKEN,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code });
    return data;
  };

  // ---- boot: silently probe; render only on success -----------------------
  let state = null;
  api("/api/state")
    .then((s) => { state = s; mount(); })
    .catch(() => { /* daemon not running — stay invisible */ });

  /* "Geist Pixel" must be registered against the document's font set for the
   * shadow DOM to see it (@font-face inside a shadow root is ignored — see the
   * note in the shadow <style>). document.fonts.add() is the one unavoidable
   * touch of the host document's font set; it's a single named face, loopback-
   * only, and inert if the file can't load — we fall through to the mono stack.
   * Guarded so repeated mounts (or a second widget instance) never double-add.
   *
   * `fontSource` is the second thing (with the token) that differs per channel.
   * The tag channel leaves it undefined and the face is fetched from the daemon
   * by URL. That fetch is issued by the *page's* document, so it answers to the
   * page's `font-src` CSP — fine for the tag channel, which a strict-CSP page
   * would have blocked at the <script> already. The extension has no such luck:
   * it runs on pages that never opted in, so it passes the font in as an
   * ArrayBuffer read from its own package. A FontFace built from binary data
   * performs no fetch at all and therefore cannot be blocked by any page CSP.
   * Either way the failure mode is the same and already handled: no face, mono
   * fallback, everything still legible. */
  function loadFont() {
    if (window.__sidebranchFont || typeof FontFace === "undefined") return;
    window.__sidebranchFont = true;
    try {
      const source = fontSource ?? `url("${DAEMON}/geist-pixel.woff2") format("woff2")`;
      const face = new FontFace("Geist Pixel", source, { display: "swap" });
      face.load().then((f) => document.fonts.add(f)).catch(() => { /* mono fallback */ });
    } catch { /* FontFace unsupported/blocked — mono fallback */ }
  }

  function mount() {
    loadFont();
    const host = document.createElement("sidebranch-widget");
    host.style.cssText = "position:fixed;z-index:2147483646;" + POSITIONS[position];
    host.dataset.pos = position;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
<style>
  /* NB: "Geist Pixel" is registered at *document* scope in loadFont() below,
     not with an @font-face here — an @font-face declared inside a shadow root
     is ignored by the browser (font matching resolves against the document's
     font set, never a shadow tree's), so it would silently never apply. */
  :host{all:initial;--ease:cubic-bezier(0.34,0.8,0.23,0.97);--bg:#191919;--surface:#222;
    opacity:1;transition:opacity .22s var(--ease)}
  :host(.hiding){opacity:0}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  .sb{font:12px/1.45 "Geist Pixel","Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d7dce2}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  input{font:inherit;color:inherit;background:none;border:0}
  :focus-visible{outline:1px solid #e3b341;outline-offset:-1px}

  .dot{display:flex;flex:none;color:#8a949e}
  .dot.ready{color:#59c26f}.dot.busy{color:#e3b341;animation:sb-p 1s infinite}
  .dot.error{color:#e5534b}
  @keyframes sb-p{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.dot.busy{animation:none}}

  /* ---- the one persistent pill/toolbar element — always fully rounded,
     it only ever grows/shrinks, never squares off ---- */
  .bar{display:flex;align-items:center;border-radius:999px;
    background:var(--bg);border:1px solid rgba(255,255,255,.04);
    box-shadow:0 2px 10px rgba(0,0,0,.2);
    animation:sb-pop .18s var(--ease);padding:4px}
  @keyframes sb-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
  @media (prefers-reduced-motion:reduce){.bar{animation:none}}

  .branch-btn{display:flex;align-items:center;padding:6px;border-radius:999px;
    user-select:none;white-space:nowrap;transition:background .15s var(--ease),padding .27s var(--ease)}
  .branch-btn:hover,.branch-btn[aria-expanded="true"]{background:rgba(255,255,255,.06)}
  .bar.expanded .branch-btn{padding:6px 11px}
  .branch-btn .name{max-width:0;opacity:0;overflow:hidden;text-overflow:ellipsis;line-height: 16px;
    transition:max-width .27s var(--ease),opacity .23s var(--ease),margin-left .27s var(--ease)}
  .bar.expanded .branch-btn .name{max-width:260px;opacity:1;margin-left:7px}
  .branch-btn .chev{flex:none;width:0;opacity:0;overflow:hidden;color:#8a949e;
    transition:width .27s var(--ease),opacity .23s var(--ease),transform .23s var(--ease),margin-left .27s var(--ease)}
  .bar.expanded .branch-btn .chev{width:10px;opacity:1;margin-left:4px}
  .branch-btn[aria-expanded="true"] .chev{transform:rotate(180deg)}
  @media (prefers-reduced-motion:reduce){.branch-btn,.branch-btn .chev,.branch-btn .name{transition:none}}

  /* grid-template-columns 0fr -> 1fr grows to the content's natural width
     without knowing it up front — the standard dependency-free technique
     for animating toward "auto". */
  .extra-wrap{display:grid;grid-template-columns:0fr;transition:grid-template-columns .31s var(--ease)}
  .bar.expanded .extra-wrap{grid-template-columns:1fr}
  .extra{min-width:0;overflow:hidden;display:flex;align-items:center;gap:3px;
    opacity:0;transition:opacity .25s var(--ease) .04s}
  .bar.expanded .extra{opacity:1}
  @media (prefers-reduced-motion:reduce){.extra-wrap,.extra{transition:none}}

  .tb-icon{display:flex;align-items:center;justify-content:center;width:30px;height:30px;
    border-radius:999px;color:#8a949e;flex:none;transition:background .15s var(--ease),color .15s var(--ease)}
  .tb-icon:hover,.tb-icon[aria-expanded="true"]{background:rgba(255,255,255,.08);color:#fff}
  .tb-sep{width:1px;height:16px;background:rgba(255,255,255,.1);margin:0 2px;flex:none}
  @media (prefers-reduced-motion:reduce){.tb-icon{transition:none}}

  /* flyouts and the status bubble are all top-level siblings of .bar (not
     nested inside .extra, which needs overflow:hidden for the morph) so
     none of them are ever clipped by that. All anchor to the same corner. */
  .flyout,.status-bubble{position:absolute;right:0;bottom:calc(100% + 8px);
    border-radius:10px;background:var(--bg);border:1px solid rgba(255,255,255,.13);
    box-shadow:0 8px 28px rgba(0,0,0,.5);
    opacity:0;transform:scale(.96) translateY(6px);pointer-events:none;
    transition:opacity .16s var(--ease),transform .16s var(--ease)}
  .flyout.open,.status-bubble.open{opacity:1;transform:none;pointer-events:auto}
  :host([data-pos^="t"]) .flyout,:host([data-pos^="t"]) .status-bubble{
    bottom:auto;top:calc(100% + 8px);transform:scale(.96) translateY(-6px)}
  :host([data-pos^="t"]) .flyout.open,:host([data-pos^="t"]) .status-bubble.open{transform:none}
  :host([data-pos$="l"]) .flyout,:host([data-pos$="l"]) .status-bubble{right:auto;left:0}
  @media (prefers-reduced-motion:reduce){.flyout,.status-bubble{transition:none}}

  .flyout{width:250px;max-height:60vh;display:flex;flex-direction:column;overflow:hidden}
  .fly-hd{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.09)}
  .fly-hd b{font-weight:400;color:#fff;flex:1}
  .fly-hd button{display:flex;align-items:center;justify-content:center;width:28px;height:28px;
    color:#8a949e;border-radius:6px;
    transition:background .15s var(--ease),color .15s var(--ease)}
  .fly-hd button:hover{color:#fff;background:rgba(255,255,255,.08)}
  .fly-hd button:disabled{opacity:.6;cursor:default}
  .fly-hd button.spinning svg{animation:sb-spin .8s linear infinite}
  @keyframes sb-spin{to{transform:rotate(360deg)}}
  .fly-filter{width:100%;padding:7px 11px;outline:0;border-bottom:1px solid rgba(255,255,255,.09)}
  .fly-filter::placeholder{color:#626b74}
  /* Replace the UA search-cancel glyph (a gray gradient X) with a plain white,
     round-capped X on a rounded hover chip, matching the icon style here. */
  .fly-filter::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;
    width:16px;height:16px;border-radius:999px;cursor:pointer;
    background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M4.5 4.5l7 7M11.5 4.5l-7 7'/%3E%3C/svg%3E") center/11px no-repeat;
    transition:background-color .15s var(--ease)}
  .fly-filter::-webkit-search-cancel-button:hover{background-color:rgba(255,255,255,.14)}
  .fly-list{overflow-y:auto;flex:1;max-height:280px}
  .row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 11px;text-align:left;
    transition:background .15s var(--ease)}
  .row:hover,.row:focus-visible{background:rgba(255,255,255,.06);outline:none}
  .row .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row[aria-selected="true"]{background:rgba(89,194,111,.12)}
  .row .cur{color:#59c26f}
  .row .check{display:flex;flex:none;color:#59c26f;opacity:0}
  .row[aria-selected="true"] .check{opacity:1}
  .row-empty{padding:10px 11px;color:#626b74}

  .fly-settings{padding:0;width:auto}
  .fly-body{padding:11px}
  .fs-label{color:#8a949e;font-size:11px;padding-bottom:9px}

  /* one rectangle standing in for "the page", with a dot inset at each
     corner — clicking one picks that corner. The active dot turns solid
     white and grows into a small pill, pinned to the same two edges it's
     already anchored to (e.g. "br" is pinned right+bottom, so it grows
     leftward) — the same corner-pinned growth the real pill/toolbar uses
     in POSITIONS above, just in miniature. */
  .pos-frame{position:relative;width:100%;height:96px;margin:0 auto 18px;
    border-radius:10px;background:var(--surface)}
  .pos-dot{position:absolute;width:12px;height:12px;border-radius:999px;
    background:rgba(255,255,255,.28);
    transition:width .2s var(--ease),background .15s var(--ease)}
  .pos-dot:hover{background:rgba(255,255,255,.55)}
  .pos-dot[aria-pressed="true"]{background:#fff;width:28px}
  .pos-dot[data-pos="tl"]{left:8px;top:8px}
  .pos-dot[data-pos="tr"]{right:8px;top:8px}
  .pos-dot[data-pos="bl"]{left:8px;bottom:8px}
  .pos-dot[data-pos="br"]{right:8px;bottom:8px}

  .fly-info{width:290px}
  .fly-info .fly-body{overflow-y:auto;max-height:52vh}
  .info-sec{margin-bottom:12px}
  .info-sec:last-child{margin-bottom:0}
  .info-note{color:#8a949e;font-size:11px;line-height:1.5;margin:0 0 8px;overflow-wrap:anywhere}
  .info-note b{color:#d7dce2;font-weight:400}
  .cmd{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 8px;
    border-radius:6px;background:rgba(255,255,255,.05);margin-bottom:4px;
    transition:background .12s ease}
  .cmd:hover{background:rgba(255,255,255,.1)}
  .cmd code{flex:1;font:inherit;color:#d7dce2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmd .copied{color:#7ee0c0;font-size:10px;opacity:0;transition:opacity .12s ease}
  .cmd.done .copied{opacity:1}
  .cmd svg{flex:none;color:#626b74}
  .cmd:hover svg{color:#8a949e}
  @media (prefers-reduced-motion:reduce){.cmd,.cmd .copied{transition:none}}
  .fly-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 0}
  .fly-toggle-label{color:#8a949e;font-size:11px;}
  .switch{flex:none;width:32px;height:18px;border-radius:999px;background:rgba(255,255,255,.16);
    padding:2px;transition:background .15s var(--ease)}
  .switch::before{content:"";display:block;width:14px;height:14px;border-radius:999px;background:#d7dce2;
    transition:transform .15s var(--ease),background .15s var(--ease)}
  .switch[aria-checked="true"]{background:#e3b341}
  .switch[aria-checked="true"]::before{transform:translateX(14px);background:#191919}
  @media (prefers-reduced-motion:reduce){.fly-hd button,.row,.pos-dot,.switch,.switch::before{transition:none}
    .fly-hd button.spinning svg{animation:none}}

  .status-bubble{display:flex;align-items:center;gap:7px;padding:7px 11px;white-space:nowrap}
  .status-bubble.err{border-color:rgba(229,83,75,.35)}
  .status-bubble.err .msg{color:#e5534b}
  .spinner{min-width:1ch;text-align:center;color:#e3b341;flex:none}
  .msg{animation:sb-fade .18s var(--ease)}
  @keyframes sb-fade{from{opacity:0}to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.msg{animation:none}}

  /* one shared tooltip, positioned via JS getBoundingClientRect (like
     shell.html's #tooltip) rather than CSS anchored to its trigger, since
     triggers live at every corner of the screen depending on position,
     and .extra's overflow:hidden would clip anything anchored inside it. */
  .tooltip{position:fixed;left:0;top:0;z-index:2147483647;padding:6px 10px;border-radius:8px;
    background:var(--bg);border:1px solid rgba(255,255,255,.13);
    box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:11px;color:#d7dce2;white-space:nowrap;
    max-width:220px;pointer-events:none;
    transform:translate(-50%,-100%) scale(.96);
    opacity:0;transition:opacity .14s var(--ease),transform .14s var(--ease)}
  .tooltip.open{opacity:1;transform:translate(-50%,-100%) scale(1)}
  .tooltip.below{transform:translate(-50%,0) scale(.96)}
  .tooltip.below.open{transform:translate(-50%,0) scale(1)}
  @media (prefers-reduced-motion:reduce){.tooltip{transition:none}}
</style>
<div class="sb">
  <div class="bar" id="bar">
    <button class="branch-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="sidebranch">
      <span class="dot" aria-hidden="true">
        <svg viewBox="0 0 100 100" width="16" height="16" fill="currentColor">
          <path d="M45 11C50.5228 11 55 15.4772 55 21V39H40C34.4772 39 30 43.4772 30 49V78C30 83.5228 34.4772 88 40 88H26C20.4772 88 16 83.5228 16 78V21C16 15.4772 20.4772 11 26 11H45ZM73 39C78.5228 39 83 43.4772 83 49V78C83 83.5228 78.5228 88 73 88H45C50.5228 88 55 83.5228 55 78V39H73Z"/>
        </svg>
      </span><span class="name">sidebranch</span>
      <svg class="chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="extra-wrap">
      <div class="extra">
        <button class="tb-icon" data-action="compare" data-tip="Compare side by side (new tab)" aria-label="Compare side by side (opens in a new tab)">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="1.5" y="3" width="5.5" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>
            <rect x="9" y="3" width="5.5" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>
          </svg>
        </button>
        <button class="tb-icon" data-toggle="external" aria-haspopup="listbox" aria-expanded="false" data-tip="Open branch in new tab" aria-label="Open branch in a new tab">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6.5 3H3.6A1.1 1.1 0 0 0 2.5 4.1v8.4A1.1 1.1 0 0 0 3.6 13.6h8.4a1.1 1.1 0 0 0 1.1-1.1V9.5"/>
            <path d="M9 2.5h4.5V7"/><path d="M13.4 2.6 7.7 8.3"/>
          </svg>
        </button>
        <div class="tb-sep"></div>
        <button class="tb-icon" data-toggle="info" aria-haspopup="true" aria-expanded="false" data-tip="Setup commands" aria-label="Setup and teardown commands">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v4"/><path d="M8 4.9h.01"/>
          </svg>
        </button>
        <button class="tb-icon" data-toggle="settings" aria-haspopup="true" aria-expanded="false" data-tip="Settings" aria-label="Settings">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <line x1="2" y1="5" x2="14" y2="5"/><circle cx="6.5" cy="5" r="1.5" fill="currentColor" stroke="none"/>
            <line x1="2" y1="11" x2="14" y2="11"/><circle cx="10" cy="11" r="1.5" fill="currentColor" stroke="none"/>
          </svg>
        </button>
        <button class="tb-icon tb-close" data-action="close" data-tip="Collapse" aria-label="Collapse toolbar">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M4 4l8 8M12 4l-8 8"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <div class="flyout" data-flyout="switch" role="listbox" aria-label="Switch to branch">
    <div class="fly-hd"><b>Switch to</b>
      <button data-fetch data-tip="git fetch --all" aria-label="Fetch remotes">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
      </button>
    </div>
    <input class="fly-filter" type="search" placeholder="Filter branches…" aria-label="Filter branches">
    <div class="fly-list"></div>
  </div>
  <div class="flyout" data-flyout="external" role="listbox" aria-label="Open branch in a new tab">
    <div class="fly-hd"><b>Open in new tab</b>
      <button data-fetch data-tip="git fetch --all" aria-label="Fetch remotes">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
      </button>
    </div>
    <input class="fly-filter" type="search" placeholder="Filter branches…" aria-label="Filter branches">
    <div class="fly-list"></div>
  </div>
  <div class="flyout fly-info" data-flyout="info">
    <div class="fly-hd"><b>Running sidebranch</b></div>
    <div class="fly-body">
      <div class="info-sec">
        <p class="info-note" data-info-channel></p>
      </div>
      <div class="info-sec">
        <div class="fs-label">Start</div>
        <div data-info-start></div>
      </div>
      <div class="info-sec">
        <div class="fs-label">Stop</div>
        <div data-info-stop></div>
      </div>
      <div class="info-sec">
        <div class="fs-label" data-info-alt-label></div>
        <p class="info-note" data-info-alt></p>
      </div>
    </div>
  </div>
  <div class="flyout fly-settings" data-flyout="settings">
    <div class="fly-hd"><b>Settings</b></div>
    <div class="fly-body">
      <div class="fs-label">Position</div>
      <div class="pos-frame" role="group" aria-label="Widget position">
        <button class="pos-dot" data-pos="tl" aria-pressed="false" aria-label="Top left" data-tip="Top left"></button>
        <button class="pos-dot" data-pos="tr" aria-pressed="false" aria-label="Top right" data-tip="Top right"></button>
        <button class="pos-dot" data-pos="bl" aria-pressed="false" aria-label="Bottom left" data-tip="Bottom left"></button>
        <button class="pos-dot" data-pos="br" aria-pressed="false" aria-label="Bottom right" data-tip="Bottom right"></button>
      </div>
      <div class="fly-toggle">
        <span class="fly-toggle-label">Hide for this session</span>
        <button class="switch" role="switch" aria-checked="false" data-hide-toggle aria-label="Hide widget for this session"></button>
      </div>
    </div>
  </div>

  <div class="status-bubble" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span><span class="msg"></span>
  </div>
  <div class="tooltip" role="tooltip"><span class="tt-text"></span></div>
</div>`;

    // Append as early as possible: even if something below throws, the
    // pill itself is already visible rather than silently never existing.
    document.documentElement.appendChild(host);

    try {
      wire(root, host);
    } catch (err) {
      console.error("sidebranch widget failed to initialize:", err);
    }
  }

  function wire(root, host) {
    const $ = (s) => root.querySelector(s);
    const bar = $(".bar");
    const branchBtn = $(".branch-btn"), branchDot = $(".branch-btn .dot"), branchName = $(".branch-btn .name");
    const btnCompare = $('[data-action="compare"]');
    const btnExternalToggle = $('[data-toggle="external"]');
    const btnInfoToggle = $('[data-toggle="info"]');
    const btnSettingsToggle = $('[data-toggle="settings"]');
    const btnClose = $('[data-action="close"]');
    const flySwitch = $('[data-flyout="switch"]');
    const flyExternal = $('[data-flyout="external"]');
    const flyInfo = $('[data-flyout="info"]');
    const flySettings = $('[data-flyout="settings"]');
    const statusBubble = $(".status-bubble");
    const statusMsg = statusBubble.querySelector(".msg");
    const statusSpinner = statusBubble.querySelector(".spinner");
    const posButtons = root.querySelectorAll("[data-pos]");
    const hideToggle = $("[data-hide-toggle]");
    const tooltip = $(".tooltip");
    const tooltipText = tooltip.querySelector(".tt-text");

    let expanded = false;
    let openFlyoutName = null; // "switch" | "external" | "info" | "settings" | null
    let busy = false;
    let filterText = "";
    let activeAction = null; // { kind: "switch"|"open", pane } — correlates SSE progress
    let spinTimer = null;
    let hideTimer = null;
    let tooltipModeActive = false;
    let tooltipShowTimer = null;
    let tooltipModeTimer = null;

    const paneById = (id) => state?.panes?.find((p) => p.id === id) || null;

    /** Is *this tab* currently looking at one of the daemon's pane servers? */
    function currentPaneId() {
      const myPort = location.port;
      if (!myPort) return null;
      const p = state?.panes?.find((pane) => String(pane.port) === myPort);
      return p ? p.id : null;
    }

    /** The branch this tab is actually showing right now, for orientation:
     * the bound pane's branch if we're on one, else the reviewer's own
     * working tree's current branch (not just a static "sidebranch" label). */
    function currentBranchLabel() {
      const curId = currentPaneId();
      if (curId) return paneById(curId)?.branch || "…";
      return state?.main?.branch || "sidebranch";
    }

    function startSpinner() {
      stopSpinner();
      if (reducedMotion) { statusSpinner.textContent = "•"; return; }
      let i = 0;
      statusSpinner.textContent = SPIN_FRAMES[0];
      spinTimer = setInterval(() => {
        i = (i + 1) % SPIN_FRAMES.length;
        statusSpinner.textContent = SPIN_FRAMES[i];
      }, 90);
    }
    function stopSpinner() {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      statusSpinner.textContent = "";
    }

    function showStatus(text, isErr = false) {
      closeFlyout();
      statusBubble.classList.add("open");
      statusBubble.classList.toggle("err", isErr);
      statusMsg.classList.remove("msg"); void statusMsg.offsetWidth; statusMsg.classList.add("msg");
      statusMsg.textContent = text;
      if (isErr) stopSpinner(); else startSpinner();
    }
    function hideStatus() {
      statusBubble.classList.remove("open", "err");
      stopSpinner();
    }

    /* -------------------------------- tooltips --------------------------------
     * Delayed like a native title (~1s) on first hover, but once one has
     * opened, hovering straight into the next trigger reopens instantly for
     * a short grace period — the same "tooltip mode" convention used by
     * shell.html's dock tooltip, so a reviewer skimming several icons in a
     * row doesn't re-wait out the delay for each one. */
    const TOOLTIP_DELAY = 1000;
    const TOOLTIP_MODE_GRACE = 400;
    function showTooltipNow(el) {
      const text = el.dataset.tip;
      if (!text) return;
      tooltipText.textContent = text;
      const rect = el.getBoundingClientRect();
      const below = host.dataset.pos.startsWith("t");
      tooltip.classList.toggle("below", below);
      tooltip.style.left = rect.left + rect.width / 2 + "px";
      tooltip.style.top = (below ? rect.bottom + 8 : rect.top - 8) + "px";
      tooltip.classList.add("open");
    }
    function scheduleTooltip(el) {
      clearTimeout(tooltipShowTimer);
      clearTimeout(tooltipModeTimer);
      if (tooltipModeActive) showTooltipNow(el);
      else tooltipShowTimer = setTimeout(() => { tooltipModeActive = true; showTooltipNow(el); }, TOOLTIP_DELAY);
    }
    function hideTooltip() {
      clearTimeout(tooltipShowTimer);
      tooltip.classList.remove("open");
      clearTimeout(tooltipModeTimer);
      tooltipModeTimer = setTimeout(() => { tooltipModeActive = false; }, TOOLTIP_MODE_GRACE);
    }
    for (const el of root.querySelectorAll("[data-tip]")) {
      el.addEventListener("mouseenter", () => scheduleTooltip(el));
      el.addEventListener("mouseleave", hideTooltip);
      // Only auto-show on a real keyboard visit, not the focus a click also
      // produces — otherwise dismissing on mousedown (below) would just get
      // immediately undone by the focus event a click fires right after it.
      el.addEventListener("focus", () => { if (el.matches(":focus-visible")) showTooltipNow(el); });
      el.addEventListener("blur", hideTooltip);
      // Clicking into the action the tooltip was explaining should dismiss
      // it right away — the reviewer already knows what they clicked.
      el.addEventListener("mousedown", hideTooltip);
    }

    function render() {
      const curId = currentPaneId();
      const curPane = curId ? paneById(curId) : null;
      const dotClass = "dot " + (busy ? "busy" : curPane?.status === "error" ? "error" : curPane?.status === "ready" ? "ready" : "");
      branchDot.className = dotClass;
      branchName.textContent = currentBranchLabel();
      if (openFlyoutName === "switch" || openFlyoutName === "external") renderList();
    }

    /* ------------------------------ expand/collapse ------------------------------ */
    function setExpanded(v) {
      expanded = v;
      bar.classList.toggle("expanded", v);
      const extraWrap = $(".extra-wrap");
      extraWrap.inert = !v;
      if (!v) { closeFlyout(); hideStatus(); tooltip.classList.remove("open"); }
      else render();
    }

    function closeFlyout() {
      if (!openFlyoutName) return;
      openFlyoutName = null;
      flySwitch.classList.remove("open"); flySwitch.inert = true;
      flyExternal.classList.remove("open"); flyExternal.inert = true;
      flyInfo.classList.remove("open"); flyInfo.inert = true;
      flySettings.classList.remove("open"); flySettings.inert = true;
      branchBtn.setAttribute("aria-expanded", "false");
      btnExternalToggle.setAttribute("aria-expanded", "false");
      btnInfoToggle.setAttribute("aria-expanded", "false");
      btnSettingsToggle.setAttribute("aria-expanded", "false");
    }

    function showFlyout(name) {
      closeFlyout();
      hideStatus();
      openFlyoutName = name;
      if (name === "switch") {
        filterText = ""; flySwitch.querySelector(".fly-filter").value = "";
        flySwitch.classList.add("open"); flySwitch.inert = false;
        branchBtn.setAttribute("aria-expanded", "true");
        renderList();
        requestAnimationFrame(() => flySwitch.querySelector(".fly-filter").focus());
      } else if (name === "external") {
        filterText = ""; flyExternal.querySelector(".fly-filter").value = "";
        flyExternal.classList.add("open"); flyExternal.inert = false;
        btnExternalToggle.setAttribute("aria-expanded", "true");
        renderList();
        requestAnimationFrame(() => flyExternal.querySelector(".fly-filter").focus());
      } else if (name === "info") {
        renderInfo();
        flyInfo.classList.add("open"); flyInfo.inert = false;
        btnInfoToggle.setAttribute("aria-expanded", "true");
      } else if (name === "settings") {
        flySettings.classList.add("open"); flySettings.inert = false;
        btnSettingsToggle.setAttribute("aria-expanded", "true");
        for (const b of posButtons) b.setAttribute("aria-pressed", String(b.dataset.pos === position));
      }
    }

    /* ------------------------------- setup info -------------------------------
     * The commands people actually need, with this daemon's real port already
     * substituted, and with the two delivery channels described honestly:
     * whichever one you are reading this through is the one described first.
     * `channel` is supplied by the boot — the widget body itself has no way to
     * know how it was delivered, and must not guess. */
    const PORT_FLAG = String(port) === "49400" ? "" : ` --port ${port}`;

    function cmdRow(text) {
      const btn = document.createElement("button");
      btn.className = "cmd";
      btn.type = "button";
      // No data-tip: tooltips are bound once over the static markup at wire()
      // time, and these rows are built on demand. The aria-label and the
      // inline "copied" flash carry it instead.
      btn.setAttribute("aria-label", `Copy: ${text}`);
      const code = document.createElement("code");
      code.textContent = text;
      const copied = document.createElement("span");
      copied.className = "copied";
      copied.textContent = "copied";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("width", "12");
      icon.setAttribute("height", "12");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.3");
      const p1 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      p1.setAttribute("x", "5.5"); p1.setAttribute("y", "5.5");
      p1.setAttribute("width", "8"); p1.setAttribute("height", "8"); p1.setAttribute("rx", "1.4");
      const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p2.setAttribute("d", "M10.5 3.5A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5a1.5 1.5 0 0 0 1 1.4");
      icon.append(p1, p2);
      btn.append(code, copied, icon);
      btn.onclick = async () => {
        try { await navigator.clipboard.writeText(text); } catch { return; }
        btn.classList.add("done");
        setTimeout(() => btn.classList.remove("done"), 1200);
      };
      return btn;
    }

    function fillCommands(el, commands) {
      el.replaceChildren(...commands.map(cmdRow));
    }

    function renderInfo() {
      const viaExtension = channel === "extension";
      $("[data-info-channel]").textContent = viaExtension
        ? "You're seeing this through the browser extension, so this app needs no script tag — only a running daemon."
        : "You're seeing this through the script tag in this app's HTML.";

      fillCommands($("[data-info-start]"), [
        "npx sidebranch init",
        `npx sidebranch start${PORT_FLAG}`,
      ]);
      fillCommands($("[data-info-stop]"), [
        "npx sidebranch stop",
        "npx sidebranch clean",
      ]);

      $("[data-info-alt-label]").textContent = viaExtension ? "Without the extension" : "With the extension";
      $("[data-info-alt]").textContent = viaExtension
        ? `Add <script src="${DAEMON}/widget.js" defer> to the app, in dev builds only.`
        : "Install the sidebranch extension and you can drop the script tag — it puts this widget on every loopback app, no HTML changes.";
    }

    function toggleFlyout(name) {
      if (openFlyoutName === name) closeFlyout();
      else showFlyout(name);
    }

    /* --------------------------------- branch lists -------------------------------- */
    function renderList() {
      const target = openFlyoutName === "switch" ? flySwitch : openFlyoutName === "external" ? flyExternal : null;
      if (!target) return;
      const list = target.querySelector(".fly-list");
      // The branch this tab is actually on — the bound pane's branch if we're
      // on a pane, else the reviewer's own working-tree branch. Mirrors
      // currentBranchLabel() so the highlighted row always matches the pill.
      // (Previously fell back to pane A's branch when not on a pane, which lit
      // up a seemingly-random branch unrelated to what this tab shows.)
      const curId = currentPaneId();
      const curBranch = curId ? paneById(curId)?.branch : state?.main?.branch;
      const branches = (state?.branches || []).filter((br) => br.name.includes(filterText));
      if (branches.length === 0) {
        list.replaceChildren(Object.assign(document.createElement("div"), { className: "row-empty", textContent: "No matching branches." }));
        return;
      }
      list.replaceChildren(...branches.slice(0, 200).map((br) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row";
        row.setAttribute("role", "option");
        const isCurrent = br.name === curBranch;
        row.setAttribute("aria-selected", String(isCurrent));
        const name = document.createElement("span");
        name.className = "name" + (isCurrent ? " cur" : "");
        name.textContent = br.name + (br.local ? "" : " ⇣");
        row.appendChild(name);
        const check = document.createElement("span");
        check.className = "check";
        check.setAttribute("aria-hidden", "true");
        check.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>`;
        row.appendChild(check);
        row.onclick = () => {
          if (openFlyoutName === "switch") doSwitch(br.name);
          else doOpenNewTab(br.name);
        };
        return row;
      }));
    }

    function wireFilter(flyoutEl) {
      const input = flyoutEl.querySelector(".fly-filter");
      input.oninput = () => { filterText = input.value.trim(); renderList(); };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.stopPropagation(); closeFlyout(); branchBtn.focus(); }
      });
    }
    wireFilter(flySwitch);
    wireFilter(flyExternal);

    async function doFetch(e) {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add("spinning");
      showStatus("Fetching remotes…");
      try { await api("/api/fetch", { method: "POST" }); await refresh(); hideStatus(); }
      catch (err) { showStatus(err.message, true); }
      finally { btn.disabled = false; btn.classList.remove("spinning"); }
    }
    flySwitch.querySelector("[data-fetch]").onclick = doFetch;
    flyExternal.querySelector("[data-fetch]").onclick = doFetch;

    /* ------------------------------ actions ------------------------------ */
    /** If this tab is already a pane, switching branch updates that same
     * pane and reloads in place. Otherwise (this tab is the reviewer's own
     * working tree) it builds pane A and navigates the tab into it — we
     * never touch the working tree's own dev server. */
    async function doSwitch(branch) {
      const here = currentPaneId();
      const paneId = here || "a";
      const pane = paneById(paneId);
      if (here && pane?.branch === branch && pane.status === "ready") { closeFlyout(); setExpanded(false); return; }
      busy = true; activeAction = { kind: "switch", pane: paneId }; render();
      showStatus(`Switching to ${branch}…`);
      try {
        const info = await api("/api/pane", { method: "POST", body: JSON.stringify({ pane: paneId, branch }) });
        if (here) location.reload();
        else location.href = info.url;
      } catch (err) {
        busy = false; activeAction = null;
        showStatus(err.message, true);
        render();
      }
    }

    /** Build (or reuse) whichever pane this tab is NOT currently viewing,
     * and open it in a new tab without touching this tab at all. */
    async function doOpenNewTab(branch) {
      const here = currentPaneId();
      const paneId = here === "a" ? "b" : "a";
      busy = true; activeAction = { kind: "open", pane: paneId }; render();
      showStatus(`Opening ${branch}…`);
      try {
        const info = await api("/api/pane", { method: "POST", body: JSON.stringify({ pane: paneId, branch }) });
        busy = false; activeAction = null;
        hideStatus();
        if (info?.url) window.open(info.url, "_blank", "noopener");
        closeFlyout(); setExpanded(false);
        render();
      } catch (err) {
        busy = false; activeAction = null;
        showStatus(err.message, true);
        render();
      }
    }

    btnCompare.onclick = () => {
      window.open(DAEMON + "/shell", "_blank", "noopener");
      setExpanded(false);
    };
    branchBtn.onclick = () => {
      if (!expanded) { setExpanded(true); return; }
      toggleFlyout(openFlyoutName === "switch" ? null : "switch");
    };
    btnExternalToggle.onclick = () => toggleFlyout(openFlyoutName === "external" ? null : "external");
    btnInfoToggle.onclick = () => toggleFlyout(openFlyoutName === "info" ? null : "info");
    btnSettingsToggle.onclick = () => toggleFlyout(openFlyoutName === "settings" ? null : "settings");
    btnClose.onclick = () => setExpanded(false);

    /* ------------------------------ settings ------------------------------ */
    for (const b of posButtons) {
      b.onclick = () => {
        position = b.dataset.pos;
        try { localStorage.setItem(POS_KEY, position); } catch { /* fine, just won't persist */ }
        host.style.cssText = "position:fixed;z-index:2147483646;" + POSITIONS[position];
        host.dataset.pos = position;
        for (const btn of posButtons) btn.setAttribute("aria-pressed", String(btn.dataset.pos === position));
      };
    }
    /* Toggling on fades the whole widget out, then removes it — toggling
     * back off mid-fade cancels the hide and fades it back in, rather than
     * committing the moment the switch is flipped. */
    hideToggle.onclick = () => {
      const on = hideToggle.getAttribute("aria-checked") !== "true";
      hideToggle.setAttribute("aria-checked", String(on));
      clearTimeout(hideTimer);
      if (!on) { host.classList.remove("hiding"); return; }
      host.classList.add("hiding");
      hideTimer = setTimeout(() => {
        try { sessionStorage.setItem(HIDE_KEY, "1"); } catch { /* fine */ }
        document.removeEventListener("pointerdown", onOutsidePointerDown, true);
        host.remove();
        // The widget is gone from the DOM, so this world is free to mount a
        // new one. Without this the extension's "show it again" would be
        // blocked by the loaded-guard even after clearing the hide flag.
        window.__sidebranchLoaded = false;
      }, reducedMotion ? 0 : 220);
    };

    /* --------------------------- open toggle + dismissal --------------------------- */
    function onOutsidePointerDown(e) {
      if (!expanded) return;
      if (e.composedPath().includes(host)) return;
      setExpanded(false);
    }
    document.addEventListener("pointerdown", onOutsidePointerDown, true);

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (openFlyoutName) {
        const trigger = openFlyoutName === "switch" ? branchBtn
          : openFlyoutName === "info" ? btnInfoToggle
          : openFlyoutName === "external" ? btnExternalToggle
          : btnSettingsToggle;
        closeFlyout();
        trigger.focus();
      } else if (expanded) {
        setExpanded(false);
        branchBtn.focus();
      }
    });

    /* --------------------------------- live state --------------------------------- */
    async function refresh() {
      try { state = await api("/api/state"); render(); } catch { /* daemon gone; keep last */ }
    }

    (async () => {
      try {
        const res = await fetch(DAEMON + "/api/events", { headers: { Authorization: "Bearer " + TOKEN } });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = /^data: (.*)$/m.exec(chunk);
            if (!m) continue;
            const ev = JSON.parse(m[1]);
            if (!activeAction || ev.pane !== activeAction.pane) continue;
            if (ev.type === "pane:installing") showStatus("Installing dependencies…");
            else if (ev.type === "pane:starting") showStatus("Starting dev server…");
            // pane:ready / pane:error resolve via the awaited POST above, not here.
          }
        }
      } catch { /* stream unavailable — status text just won't live-update mid-build */ }
    })();

    render();
    setInterval(refresh, 5000);
  }
};
