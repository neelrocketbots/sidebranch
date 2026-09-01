# sidebranch — browser extension

The second delivery channel for the sidebranch widget. Identical UI to the
`<script src>` tag, minus the tag: install once and every project you run
`sidebranch start` in gets the pill, with no change to the app's HTML.

The daemon is still doing all the work. This extension is a loader with a
credential handshake and an options page; if no daemon is running, it renders
nothing and the page is untouched.

## Load it unpacked

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Run `sidebranch start` in a project, open its dev server on
   `http://localhost:…`, and the pill appears bottom-right.

There is no build step — the directory is the extension. Three files
(`widget-core.js`, `geist-pixel.woff2`, `geist-pixel.LICENSE.txt`) are
deliberate copies of the ones in `src/assets/`; `test/extension.test.js`
fails if they drift, so re-copy rather than edit them here.

## How it differs from the script tag

| Situation | Script tag | Extension |
| --- | --- | --- |
| Setup | One tag, gated to dev | Install once, every repo |
| Non-default port | Baked into the tag | Options page |
| Page has a strict CSP | Tag can be blocked | Content script isn't subject to it |
| IPv6 `http://[::1]:5173` page | Works | Not matchable in MV3 — use `localhost` |
| `"widget": false` | Daemon serves a no-op | Handshake reports it; the boot obeys |
| Compare view (`/shell`) | Identical | Identical |

The IPv6 gap is a Chrome limitation: match patterns cannot express an IPv6
literal host, so `http://[::1]:5173` is unreachable to any extension. The tag
still covers it, and `http://localhost` resolves to the same server.

## The one rule

**All daemon traffic goes through the content script.** A content script's
`fetch` carries the page's origin (`http://localhost:5173`), which the
daemon's Origin allowlist already admits. A background service worker's would
carry `chrome-extension://<id>`, which the daemon rejects on protocol — and
allowlisting it would mean admitting the first non-loopback origin in this
tool's history. That is why there is no service worker here at all, and why
the options page's **Test connection** button asks a content script to make
the request instead of making it itself.

## Store submission notes

Answers to the questions the Chrome Web Store listing asks, so they don't have
to be reconstructed later:

- **Single purpose.** Show a control for switching the local dev server
  between git branches, served by a sidebranch daemon on the user's own
  machine.
- **`storage`.** Stores one integer: the daemon's port, when the user runs it
  on something other than 49400.
- **Host permission, `http://localhost/*` + `http://127.0.0.1/*`.** The
  extension talks to a daemon on the user's machine and injects the widget
  into their local dev server's pages. It requests no other origin, so it is
  never injected into ordinary browsing.
- **Remote code.** None. The widget is bundled in this package; nothing is
  fetched and evaluated. The only network requests are to the loopback daemon
  and they carry data, not code.
- **Data collected.** None, of any category. No analytics, no telemetry, no
  remote server.

Still needed for a listing, and not in this repo: screenshots, a privacy
policy URL (a page stating the above), and the $5 one-time developer fee.

`manifest.json`'s `version` is the extension's own and moves on the Web
Store's clock, independent of the npm package's. What must stay in step is
`API_VERSION` in `boot-extension.js` and in `src/daemon.js` — a test enforces
that, and a mismatch at runtime makes the widget refuse to render rather than
half-work.

## License

MIT, except `geist-pixel.woff2`, which is SIL OFL 1.1 — see
`geist-pixel.LICENSE.txt`, which must ship wherever the font ships.
