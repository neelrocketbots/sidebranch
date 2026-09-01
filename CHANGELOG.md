# Changelog

Notable changes to sidebranch. This project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **A worktree deleted from disk but still registered in git no longer
  wedges its pane.** That state — left by a crash or a hand-run `rm -rf`
  under `~/.sidebranch/` — used to fail every retry with a misleading
  `spawn git ENOENT` (Node's error for a missing cwd). `ensurePane` now
  prunes the stale registration and recreates the worktree; `doctor` reports
  the state when it sees it. Fixing this surfaced a second bug: worktree
  path matching used to fail for deleted directories on macOS tmp paths
  (the `/var` → `/private/var` symlink), which would have made the heal
  silently miss.

- Piping CLI output (`sidebranch stop | head -1`) no longer crashes with
  EPIPE when the pipe closes early.

- **The extension no longer injects the widget into the daemon's own `/shell`
  page.** The compare view is served on loopback, so it matched the content
  script like any dev server, and got a pill offering to switch branches on top
  of the view that already does that.

- **CI actually runs on Node 20 now.** The test script was
  `node --test "test/*.test.js"`, and Node only learned to expand a quoted
  glob passed to `--test` in v21 — so both Node 20 jobs (Linux and macOS)
  had been failing on `Could not find '.../test/*.test.js'` without running a
  single test, while 22 and 24 passed. The glob is now unquoted and expanded
  by the shell, which works on every supported version. No test or source
  change was needed: the suite passes 41/41 on Node 20 once it can find it.

- The widget is no longer a string template. `src/assets/widget.js` split
  into `widget-core.js` (the whole UI, defining
  `globalThis.__sidebranchStart({token, port})`) and `boot-tag.js` (the
  `<script src>` channel's credential delivery, which the daemon appends and
  substitutes into). **No user-visible change** — `GET /widget.js` serves the
  same assembled script it always did. This is what lets a browser extension
  ship the identical widget body without shipping a secret or violating
  Manifest V3's ban on remotely-fetched code.

- The bundled UI font is now `geist-pixel.woff2` (24 KB) instead of
  `geist-pixel.ttf` (3.7 MB), served from `GET /geist-pixel.woff2`. The
  upstream variable font's `ELSH` axis — which sidebranch never varied — was
  pinned to its default, dropping a 2.8 MB `gvar` table, and the result
  converted to WOFF2. All 481 glyphs are retained; nothing renders
  differently. Package size drops from 3.8 MB unpacked to ~150 KB.
- `SECURITY.md` now names a concrete reporting route rather than gesturing
  at one.

### Added

- **View ports: the compare view now works with apps that refuse framing.**
  Each pane gets a local pass-through proxy that deletes `X-Frame-Options`
  and CSP `frame-ancestors` — the two headers that blanked `/shell` for apps
  sending them — and nothing else. Removals are declared in a
  `Sidebranch-Removed-Headers` response header; bodies stream through
  byte-identical; the proxy carries the daemon's loopback/Host gate (upgrades
  included) and rejects cross-site requests, so remote pages can't frame a
  pane through it. Off switch: `"frameProxy": false`, which falls back to the
  detect-and-explain behavior. Direct pane ports are untouched.

- The widget has an **info flyout** (the ⓘ in the toolbar) with the start and
  stop commands, click-to-copy, this daemon's real port already substituted,
  and a line naming which delivery channel you are actually looking at —
  script tag or extension — plus how to switch to the other one.

- **A pane that refuses to be framed now says so.** `/shell` embeds panes from
  a different origin (different port), so an app sending
  `X-Frame-Options: SAMEORIGIN` or a restrictive `frame-ancestors` renders as
  a blank rectangle there, with the browser's explanation trapped in a frame
  the shell cannot read. The daemon now probes for those headers once per
  server start and the shell names the header and the fix instead.

- **The extension's toolbar popup**, whose job is undoing "Hide for this
  session". That flag is `sessionStorage`, so it is per tab, and the only way
  back used to be opening a new tab — the control you would click to unhide is
  the widget you just hid.

- **The browser extension** (`extension/`), the widget's second delivery
  channel: install once and every project you run `sidebranch start` in gets
  the pill, with no `<script>` tag in the app. MV3, loadable unpacked, and not
  part of the npm package. Its whole permission surface is `storage` (one
  integer: a port override) plus host permissions for `http://localhost/*` and
  `http://127.0.0.1/*`. There is no background service worker — a worker's
  fetches would carry a `chrome-extension://` origin the daemon rejects — so
  all daemon traffic, including the options page's connection test, goes
  through the content script and every invariant in `SECURITY.md` holds
  unchanged. Two behaviors differ from the tag by nature: a page's strict CSP
  can't block it, and a page served from `http://[::1]` can't be matched by
  it.

- `widget-core.js`'s entry point accepts a `fontSource`, so a caller can hand
  it the font as binary instead of a URL. The tag channel leaves it undefined
  and is unchanged; the extension passes an ArrayBuffer read from its own
  package, because a `FontFace` built from a URL is fetched under the *page's*
  `font-src` CSP and would silently drop the widget to fallback mono on a
  strict dev server.

- A landing page under `site/`, deployed to GitHub Pages. Not part of the
  npm package (`files` excludes it) and adds no dependencies — one static
  page reusing the tool's own palette, mark, and (OFL-licensed, notice
  included) Geist Pixel build.

- `GET /handshake` — an unauthenticated credential bootstrap reporting
  `{token, port, widget, version, apiVersion}`, behind the same
  loopback/Host/Origin gate as every other route. It exists for the browser
  extension, which cannot consume a token substituted into a response body,
  and discloses nothing that `GET /widget.js` did not already disclose.

- `sidebranch stop` — shuts down the daemon and its pane dev servers from
  any terminal. Backed by a per-repo `daemon.json` record, which also lets
  `start` refuse to launch a second daemon over an existing one, lets
  `clean` refuse to delete worktrees out from under a running dev server,
  and lets `doctor` report daemon status. Stale records (from a `kill -9`
  or a closed terminal) are detected and cleared rather than acted on; no
  command will signal a process it has not confirmed is a sidebranch
  daemon.

- `src/assets/geist-pixel.LICENSE.txt` — the bundled font is SIL OFL 1.1,
  not MIT, and previously shipped without its license text. It now carries
  the full license, the upstream copyright notices, and a record of the
  modifications made, as OFL clauses 1 and 2 require.
- CI: the test suite runs on Node 20/22/24 across Linux and macOS, and
  asserts the dependency count is still zero.
- `prepublishOnly` runs the suite, so a red build cannot reach the registry.
- Releases publish from a tagged workflow with npm provenance.

## [0.1.0]

Initial release: loopback-only PR review sidecar with worktree panes, an
in-page widget, and the side-by-side / blend / layer compare shell.
