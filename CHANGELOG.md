# Changelog

Notable changes to sidebranch. This project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
