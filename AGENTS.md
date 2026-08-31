# AGENTS.md

Canonical reference for any AI agent (or human) working in this repository.
`CLAUDE.md` just points here — keep this the single source of truth rather
than letting two docs drift.

## What this is

sidebranch: a local, zero-dependency sidecar for reviewing PRs from inside a
running app — pick a branch from an in-page widget, it builds in an isolated
`git worktree` on its own dev server, your own working tree is never
touched. See `README.md` for the user-facing pitch and `SECURITY.md` for the
full threat model. This file is about building/changing the tool itself.

## Non-negotiables — read before touching anything

1. **Zero runtime dependencies.** `package.json`'s `dependencies` must stay
   `{}`. Everything is Node builtins (`http`, `fs`, `child_process`, `net`,
   `crypto`, `events`) and vanilla browser APIs. Don't reach for a package
   to solve a problem here — solve it with what's already available, or
   accept a rougher edge.
2. **The security invariants in `SECURITY.md` are not configurable and not
   negotiable.** Loopback-only bind, peer-address check, Host header
   allowlist, Origin allowlist, bearer token on every `/api/*` call, no
   shell ever (`execFile`/`spawn` with argument arrays only), no filesystem
   routing. If a bug or feature request seems to require relaxing one of
   these, it doesn't — find a different way, or say so explicitly rather
   than quietly loosening a check.
3. **Never run a mutating git command against the user's primary working
   tree.** Reads only (`status`, `branch --list`, `for-each-ref`, etc.).
   All mutation happens inside `~/.sidebranch/projects/*/panes/*`
   worktrees, which are append-only from the tool's perspective — a dirty
   pane fails closed (`EDIRTY`) rather than being silently reset, unless
   the caller explicitly opts into `discard`.
4. **`repoRoot` resolves from `process.cwd()`, exactly like git.** There is
   no `--repo` flag and no safety check. Run `sidebranch start` from
   *inside this repo* and it will happily start managing itself (this
   repo is a git repo like any other) — which is occasionally what you
   want and usually isn't. Always confirm the `repo` path the startup
   banner prints matches what you expect before trusting anything that
   follows.

## Architecture

```
bin/sidebranch.js  -> src/cli.js         init | start | stop | clean | doctor
src/daemonfile.js                         per-repo {pid,port} record: lets stop signal a daemon
                                           and start/clean/doctor detect one. Liveness is proven
                                           twice (pid + /healthz) — never trust the pid alone.
src/config.js                            .sidebranch.json load/normalize, data-dir resolution.
                                           normalizeEnv() sanitizes the `env` map; RESERVED_ENV
                                           lists the vars sidebranch injects and config can't set.
src/gitops.js                             every git invocation (execFile only; refs validated twice)
src/manager.js                            pane orchestration: worktree -> checkout -> conditional
                                           install -> (re)start dev server. Mutations serialized
                                           through Manager.run() so concurrent widget clicks can't
                                           interleave git operations on the same pane.
src/processes.js                          DevServer: spawns/supervises one dev server per pane,
                                           confirms readiness by polling the port (never parses
                                           stdout — some servers pick a different port than asked)
src/install.js                            lockfile hashing (skip reinstall when unchanged) + install.
                                           Also hosts pushRing/tailText, the small ring-buffer +
                                           collapsed-tail helpers DevServer and Manager both reuse to
                                           bake a snippet of captured output into failure messages.
src/daemon.js                             HTTP server: loopback/Host/Origin gate, bearer auth,
                                           routes, SSE event stream (/api/events), GET
                                           /api/pane/:id/log for a pane's full install+server output,
                                           GET /handshake (unauthenticated token bootstrap for the
                                           extension; API_VERSION lives here)
src/security.js                           the trust boundary every check in daemon.js/gitops.js
                                           relies on
src/assets/widget-core.js                 in-page pill/toolbar; runs INSIDE the consumer app's
                                           page, shadow DOM (mode:"closed"). Defines
                                           globalThis.__sidebranchStart({token, port}) and does
                                           nothing on load — a boot file calls it.
src/assets/boot-tag.js                    the <script src> channel's boot: carries the
                                           __SIDEBRANCH_* placeholders, appended to core by
                                           Daemon.serveWidget(). The extension has its own boot
                                           that calls the same entry point after GET /handshake.
src/assets/shell.html                     the /shell compare view (side-by-side / blend / onion)
src/assets/geist-pixel.woff2              bundled UI font for widget.js/shell.html, served at
                                           GET /geist-pixel.woff2 (unauthenticated — see below).
                                           OFL 1.1, NOT MIT — see geist-pixel.LICENSE.txt
```

## Conventions specific to this codebase

- **Untrusted-ish display data goes through `.textContent`, never
  `.innerHTML`.** Branch names, commit subjects, and error messages
  ultimately trace back to git or a spawned process; even though they're
  already constrained server-side (`isSafeRefName` + `git
  check-ref-format`), keep the discipline of `.textContent` for anything
  dynamic. Static structural markup can use `innerHTML` template literals
  because it contains no interpolated data.
- **All child-process spawns use `execFile`/`spawn` with argument arrays,
  `shell:false`.** Never build a command string and hand it to a shell.
  `install.js`'s `splitCommand()` is the (intentionally minimal — no glob,
  no `$VAR`, no pipes) argv splitter for config-supplied commands; don't
  make it cleverer than it needs to be, that cleverness is exactly where
  shell-like injection surface grows back.
- **A `.sidebranch.json` `dev`/`install` command is resolved via plain
  `spawn()`, which does *not* add `node_modules/.bin` to `PATH` the way
  `npm run`/`pnpm run` do.** A bare binary name (`"next dev"`) will
  `ENOENT` unless it happens to be globally on `PATH`. The working recipe
  for an npm/pnpm/yarn project is to route through the package manager
  (`"pnpm exec next dev -p {port}"`, `"npm run dev -- -p {port}"`), not
  invoke the binary directly. Update the README's recipe table if another
  framework turns out to have this same gotcha.
- **Config `env` is layered *under* sidebranch's own vars, never over them.**
  `DevServer.start()` builds the child env as
  `{ ...process.env, ...this.env, PORT, BROWSER, FORCE_COLOR, SIDEBRANCH }` —
  in that order, deliberately. Config `env` overrides the inherited
  environment (that's its whole job: point a pane at a shared service, or
  unset a stale credential path with `""`), but the sidebranch-owned vars are
  written *after* it so they always win. `PORT` especially must never be
  config-settable — it is the per-pane port injection the tool is built on.
  `normalizeEnv()` in config.js already strips `RESERVED_ENV` and any
  non-string/NUL/badly-named entries, so the spawn merge is belt-and-braces,
  not the only guard. Keep both. An empty-string value is meaningful (unset)
  and must survive normalization — don't "clean it up" as falsy.
- **Every spawned child process needs an `error` listener.** `ChildProcess`
  is an `EventEmitter`; Node throws (crashing the whole process) on an
  `'error'` event with no listener. `processes.js`'s `DevServer.start()` is
  the reference pattern: race an `AbortController`-signaled
  `waitForReady()` against the child's `error`/`exit` events, so a bad dev
  command fails just that one pane's `ensurePane()` call instead of taking
  down every other pane and the daemon itself. Any new spawn call must
  follow the same shape.
- **CSS: a plain class selector outranks the browser's built-in
  `[hidden]{display:none}` rule.** If a rule sets `display`/`visibility`
  on an element that's also toggled via the `hidden` *attribute*
  (`el.hidden = true`), scope the rule with `:not([hidden])`, or give an
  explicit `[hidden]{display:none}` rule equal-or-higher specificity —
  otherwise the JS toggle silently does nothing and the element stays
  visible on top of whatever it was supposed to hide.
- **Don't duplicate a live iframe to fake a second "view" of it.** A second
  `<iframe src="...">` pointed at the same URL is a fresh, independent
  browsing context; it does not see any client-side state (login, current
  route, scroll position) that a reviewer produced by interacting with the
  first one. To actually reuse live state, move the *same* iframe node with
  `Element.prototype.moveBefore` (ships in Chrome 133+; preserves the
  browsing context across a DOM move) and fall back to a plain
  `appendChild`/`insertBefore` elsewhere, which reloads the frame — an
  acceptable, documented degradation, not a silent state divergence.
- **The widget must never contain a baked-in token, and `widget-core.js`
  must never reference `__SIDEBRANCH_*` placeholders.** The token arrives as
  an argument to `__sidebranchStart({token, port})`, because there are two
  delivery channels and only one of them can receive a rendered template:
  - `<script src=".../widget.js">` — the daemon concatenates
    `widget-core.js` + `boot-tag.js` and substitutes into the boot.
  - the browser extension — which **cannot** do that. Manifest V3 forbids
    executing remotely-fetched code, so a content script may not fetch
    `/widget.js` and eval it; the extension ships `widget-core.js` verbatim
    in its own package and calls the same entry point with a token from
    `GET /handshake`.

  So "just inline the token again, it's simpler" silently breaks the
  extension channel and puts a secret into a file that gets published to the
  Chrome Web Store. There is a test asserting core contains neither the
  placeholder nor the live token.

  The other rule that falls out of this: **all extension traffic to the
  daemon goes through the content script, never a background service
  worker.** A content script's `fetch` carries the *page's* origin
  (`http://localhost:5173`), which `isAllowedOrigin` already admits. A
  service worker's carries `chrome-extension://<id>`, which it rejects on
  protocol — and "fixing" that by allowlisting an extension origin would
  admit the first non-loopback origin in this tool's history. Don't. Route
  through the content script and SECURITY.md's invariants hold unchanged.
- **The widget runs inside arbitrary consumer pages via a closed shadow
  root** (`attachShadow({mode:"closed"})`, `:host{all:initial}`)
  specifically so the token can't leak and the host page's styles/scripts
  can't collide with it. Keep all new widget UI inside that shadow root;
  never attach anything to the light DOM beyond the single
  `<sidebranch-widget>` host element.
- **Accessibility baseline, even with zero dependencies to lean on:**
  icon-only buttons get `aria-label`; anything that opens a flyout/panel
  gets `aria-haspopup`/`aria-expanded`; every clickable row is a real
  `<button>` (never a `<div onclick>`), which makes keyboard operability
  free rather than something to bolt on. `Escape` should back out one
  level at a time (flyout → toolbar → nothing), not jump straight to
  fully closed.
- **Animating a pill growing into a toolbar (or any "expand to fit
  content" morph) without knowing the target width up front:** make the
  growing region a single-track CSS Grid and transition
  `grid-template-columns` between `0fr` and `1fr`. This is the
  dependency-free way to animate toward "auto" width — plain `width` or
  `max-width` transitions either need a known end value or animate at an
  uneven perceived speed once content is narrower than the max. See
  `.extra-wrap` in `widget.js`.
- **Don't nest a flyout/popover inside a container that uses
  `overflow:hidden` for an unrelated collapse/morph animation.** The
  `.extra-wrap`/`.extra` morph above needs `overflow:hidden` to visually
  clip the toolbar icons while collapsed; a flyout popping up *above* that
  container (`bottom:calc(100% + 8px)`) would be clipped too, since
  `overflow:hidden` cuts anything rendered outside its box regardless of
  the descendant's own `position`. Keep flyouts (and anything else meant
  to visually escape its logical parent) as top-level siblings of the
  morphing element instead, anchored independently to the same corner.
- **A JS exception partway through mounting the widget must not make the
  whole thing silently vanish.** `mount()` appends the host element to
  `document.documentElement` *before* doing any further DOM lookups, event
  wiring, or `render()` calls, and wraps that remaining setup in its own
  `try/catch` (logging via `console.error`, browser-side — that's not the
  server-side `console.log` ban from the consumer app's CLAUDE.md, this
  file never runs on a server). Without that ordering, a bug anywhere in
  the wiring throws inside the outer `api("/api/state").then(...)`, which
  is swallowed by the same `.catch()` that's there for "daemon not
  running" — so the pill never appears and there's no trace of why.
- **Bundling a font file stays zero-dependency as long as it's a static
  asset the daemon serves itself** — no npm package, no CDN `<link>`
  (that would be a live network dependency, and a privacy leak for
  something injected into someone else's dev page). `src/assets/geist-pixel.woff2`
  is loaded into memory at daemon startup exactly like `widget.js`/
  `shell.html`, and served from a third fixed route,
  `GET /geist-pixel.woff2` — a deliberate, documented expansion of
  `SECURITY.md` invariant 7 (was "exactly two" embedded assets, now
  three; the "no filesystem routing" guarantee itself is unaffected,
  since the new route is just as hardcoded as the first two). Two things
  that are easy to get wrong when adding an asset like this:
  - It must stay **unauthenticated**, same as `widget.js`/`/shell` — a
    browser's `@font-face` fetch can't attach an `Authorization` header,
    so gating it by token was never an option. That's fine: unlike
    `widget.js`/`shell.html`, this file embeds no token and no per-run
    state, so it's also safe to cache hard (`public, max-age=31536000,
    immutable`) rather than `no-store`.
  - `shell.html` serves its own CSP (`default-src 'none'` with specific
    allowances). A `font-src` directive has to be added explicitly —
    fonts fall back to `default-src` when `font-src` is absent, so the
    `@font-face` fetch would otherwise be silently blocked by the CSP
    despite the daemon happily serving the file.
  - The cross-origin CORS reflection in `Daemon.gate()` already covers
    any new route for free (it runs before routing, keyed only on the
    `Origin` header) — don't add per-route CORS handling.
- **The bundled font is a modified build, and must stay one.** Upstream
  Geist Pixel is a 3.7 MB variable TTF whose `gvar` table (2.8 MB, 77% of
  the file) exists solely to drive an `ELSH` axis that nothing in this
  codebase ever varies. `src/assets/geist-pixel.woff2` is that font with
  `ELSH` pinned to its default and the result converted to WOFF2: 24 KB,
  all 481 glyphs retained, visually identical for every way we use it.
  Regenerating it (one-time, offline, no runtime dep — `fonttools` in a
  throwaway venv):

  ```sh
  fonttools varLib.instancer upstream.ttf ELSH=0 -o static.ttf
  pyftsubset static.ttf --output-file=src/assets/geist-pixel.woff2 \
    --flavor=woff2 --unicodes='*' --layout-features='*' --name-IDs='*'
  ```

  Do **not** replace it with the upstream binary "to be safe" — that's a
  152x size regression for zero visual gain. And it is **OFL 1.1, not
  MIT**: `src/assets/geist-pixel.LICENSE.txt` carries the license text,
  the copyright notices, and a record of exactly these modifications.
  That file ships in the npm tarball and must keep shipping; dropping it
  makes every publish a license violation. Upstream declares no Reserved
  Font Name, which is the only reason this modified build may keep the
  "Geist Pixel" family name — check that again if you ever re-derive it
  from a different upstream release.

## Testing

```sh
node --test "test/*.test.js"
```

Covers the security gauntlet (token, Host/Origin gating, hostile ref
names), the full worktree lifecycle against real fixture repos, and an
end-to-end run that boots two panes on two branches and asserts both
actually serve. Run this after touching anything under `src/*.js`.

It does **not** exercise `widget.js`/`shell.html`'s in-browser behavior —
Node's test runner has no DOM. There's no headless-browser dependency in
this project by design (zero deps), and adding one just for testing would
violate that for the sake of the test suite, which isn't the tradeoff to
make. When changing widget/shell behavior, describe precisely what to
click and what should happen, verify what you can at the HTTP/API level
(token substitution, response codes, response bodies), and say plainly
that the visual/interactive result needs a human to actually look at it —
don't claim success you can't see.

## Known gaps / ideas not yet built

Surfaced while dogfooding this tool against a real consumer app
(2026-07-22):

- ~~**No `sidebranch stop` command or PID file.**~~ *Closed.* See
  `src/daemonfile.js`: the daemon records `{pid, port}` to
  `~/.sidebranch/projects/<repo>/daemon.json`, which gave `stop` something
  to signal and gave `start`/`clean`/`doctor` something to check. The rule
  to preserve if you touch it: **a pid on disk is a claim, not a fact.**
  `readRecord()` proves liveness twice — the pid exists *and* `/healthz`
  answers on the recorded port — because the OS recycles pids, and a
  record left behind by a `kill -9`'d daemon can name a completely
  unrelated process. Acting on the pid alone means `sidebranch stop` kills
  a bystander; there is a test named for exactly that
  (`test/cli.test.js`). `stopDaemon()` also sends SIGTERM only and never
  escalates to SIGKILL — the daemon's own signal handler is what reaps
  pane dev servers, so forcing it would orphan the children the command
  exists to clean up.
- **The widget's "open in new tab" flow always targets whichever pane the
  current tab *isn't* currently bound to** — there's no way to reach a
  third concurrent preview from the pill alone (bounded by the `panes`
  config, default 2, max 4). `/shell`'s own A/B `<select>`s remain the
  only place both named panes are addressable directly by id.
- **No visual regression / screenshot testing for `widget.js`/`shell.html`**
  — see the zero-headless-browser-dependency note above. Behavior changes
  to either file need a human describing what they actually saw.
