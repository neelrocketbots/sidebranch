# sidebranch

Review pull requests from inside your running app. sidebranch is a local
sidecar daemon plus a small in-page widget: pick any branch from a floating
control, and it appears in a dedicated **review worktree** on its own dev
server — your own working tree, uncommitted changes and all, is never
touched. Open a PR branch next to `main` in a synced side-by-side view,
resize both viewports together, or stack them with a blend/layer diff to
spot visual regressions.

- **Framework-agnostic.** Next on 3000, Vite on 5173, Django on 8080 —
  if it can be started by a command and answers HTTP on a port, it works.
- **Nothing ever leaves your machine.** The daemon binds loopback only,
  every request is authenticated, and the widget is inert anywhere except
  a localhost page. Zero runtime dependencies — the entire tool is Node
  builtins, so there is no supply chain to trust.
- **Unobtrusive.** One small pill in the corner, rendered only when the
  daemon is actually running. `×` hides it for the session; Esc closes the
  panel; `"widget": false` in config turns it off entirely.

## How it works

```
your app (:5173, your working tree — never touched)
   └── <script src="http://localhost:49400/widget.js">   ← the widget
sidebranch daemon (127.0.0.1:49400)
   ├── pane A → worktree ~/.sidebranch/…/panes/a → dev server :4410
   ├── pane B → worktree ~/.sidebranch/…/panes/b → dev server :4411
   └── /shell → compare view (side-by-side / blend / layer)
```

Panes are persistent review environments built on `git worktree`. Switching
a pane to another branch is a checkout inside that pane — dependencies are
re-installed **only when a lockfile actually changed** (content-hash
comparison), and the dev server is restarted only in that case; otherwise
the running server's file watcher picks up the checkout like any other
file change. Because panes are never edited by hand, they are always clean:
there is nothing to stash and nothing to lose, by construction.

## Quick start

```sh
cd your-repo
npx sidebranch init      # writes .sidebranch.json — edit for your stack
npx sidebranch start     # daemon on http://127.0.0.1:49400
```

Add the widget to your app, **dev builds only**:

```html
<script src="http://localhost:49400/widget.js" defer></script>
```

Gate it however your stack gates dev-only code, e.g.:

```jsx
// Next.js (app/layout.tsx)
{process.env.NODE_ENV === "development" && (
  <script src="http://localhost:49400/widget.js" defer />
)}
```

```html
<!-- Vite (index.html) -->
<script>
  if (import.meta.env.DEV) {
    const s = document.createElement("script");
    s.src = "http://localhost:49400/widget.js"; s.defer = true;
    document.head.appendChild(s);
  }
</script>
```

(If the tag ever ships to production anyway, it is harmless: the widget
refuses to run on non-localhost pages, and a visitor's own daemon — if they
even run one — rejects requests from non-loopback origins. See SECURITY.md.)

Then: click the pill → pick a branch → it builds and serves in pane A →
**Open A** views it, **Compare A/B** opens the split view.

### Or skip the tag: the browser extension

The widget also ships as a Chrome/Edge extension, which puts the same pill on
every project you run `sidebranch start` in without touching any app's HTML.
It lives in [`extension/`](extension/) and loads unpacked today:

```
chrome://extensions → Developer mode → Load unpacked → select extension/
```

It requests exactly two origins — `http://localhost/*` and
`http://127.0.0.1/*` — and one permission, `storage`, for a port override on
its options page. It collects nothing and talks to nothing but your own
daemon. If no daemon is running, it renders nothing.

Two differences worth knowing before you pick a channel:

- **A strict `Content-Security-Policy` on your dev server can block the script
  tag.** It cannot block the extension, whose content script isn't subject to
  the page's CSP (the widget's font is bundled and loaded as binary data
  specifically so a strict `font-src` can't downgrade it either).
- **A page served from `http://[::1]:5173` gets no widget from the
  extension** — Chrome match patterns can't express an IPv6 literal. The tag
  covers that case, and `http://localhost` reaches the same server.

Everything else is identical, including the compare view, which is served by
the daemon and needs no extension support at all. See
[`extension/README.md`](extension/README.md) for the details.

Hidden the widget with **Hide for this session** and want it back? That flag is
per tab, so a reload won't clear it — click the sidebranch toolbar icon and
choose **Show the widget here**. (With the script tag, open the app in a new
tab.)

## Configuration (`.sidebranch.json`)

```jsonc
{
  "dev": "npm run dev",                 // start command, run inside each pane
                                        //   {port} is substituted; PORT env is always set
  "install": "pnpm install",            // run only when lockfiles change; "" disables
  "ready": { "path": "/", "statuses": null },  // readiness probe; null = any HTTP answer
  "panes": 2,                           // review environments kept warm (1–4)
  "basePort": 4410,                     // first port tried for pane servers
  "copy": [".env", ".env.local"],       // untracked files copied into new worktrees
  "env": {},                            // extra env vars for the pane dev command
                                        //   overrides inherited values; PORT etc. are reserved
  "lockfiles": ["package-lock.json"],   // override the manifest list if needed
  "widget": true                        // false → /widget.js serves a no-op
}
```

Recipes:

| Stack | `dev` | `install` |
| --- | --- | --- |
| Next.js | `npm run dev` | `npm install` |
| Vite | `npx vite --port {port}` | `pnpm install` |
| Django | `python3 manage.py runserver 127.0.0.1:{port}` | `pip install -r requirements.txt` |
| Rails | `bin/rails server -p {port}` | `bundle install` |
| Static | `python3 -m http.server {port} --bind 127.0.0.1` | *(empty)* |

The daemon never parses server output — a pane is "ready" when its port
answers the probe, which also catches servers that silently pick a
different port than asked.

## Complex apps: multiple processes, databases, and credentials

sidebranch runs exactly **one process per pane** and injects **one port**.
Real apps often need more — a database or emulator, an auth proxy, a
background worker, and credentials to reach cloud services. None of that
requires sidebranch to grow; it takes one architectural idea plus two config
levers.

### The one rule: per-pane process, shared singletons

Your `dev` command is the only thing sidebranch runs per pane, and it can
only vary one port. So anything that is a **singleton** — a database, an
emulator on a fixed port, an auth proxy — must run **once, outside
sidebranch**, and be shared by every pane *and* your own dev session. Keep
the per-pane command down to the single server that actually renders the
branch (usually your web dev server) and pull everything else out.

Concretely: if your normal dev command is a bundle like
`concurrently "db" "web" "proxy"`, do **not** point sidebranch at it — two
panes would each try to start the db and proxy on the same fixed ports and
collide. Instead:

- point `dev` at just the web server (`"dev": "npm run dev:web"`),
- run the db/emulator/proxy once yourself (your normal dev session usually
  already does), and
- tell each pane how to reach them with `env` (below).

### Two levers for everything a pane needs

| Need | Lever | How |
| --- | --- | --- |
| An untracked **file** the app reads (`.env`, a service-account key, a cert) | `copy` | Copied from your main tree into each pane once, at creation. |
| An **environment variable** (point at a shared service, flip a mode, unset a stale path) | `env` | Injected into the pane's dev command; overrides inherited values. |
| A credential in a **machine-wide, out-of-tree location** (`~/.config/gcloud`, `~/.aws`, `~/.netrc`) | *(nothing)* | Panes run as you, from a worktree under `~/.sidebranch/`, so home-dir credentials resolve for free. |

The third row is the one people miss: **only in-repo, relative-path
credentials break in a pane** (they resolve against the pane's own
directory, where the file isn't). Credentials that live in your home
directory Just Work — no `copy`, no `env`.

### `env`: precedence and the empty-string unset

`env` values are layered on top of the inherited environment, so they
override what your shell exported and what a copied `.env` would set. The one
thing config `env` **cannot** touch is the set of vars sidebranch owns —
`PORT`, `BROWSER`, `FORCE_COLOR`, `SIDEBRANCH` — because overriding `PORT`
would break the port injection the whole tool is built on. Those are dropped
from `env` if you set them.

Setting a var to the **empty string** is a supported, deliberate way to
*unset* an inherited value:

```jsonc
"env": { "GOOGLE_APPLICATION_CREDENTIALS": "" }
```

This is the clean fix when a copied `.env` points a credential at an in-repo
relative path: blank it in the pane and let the SDK fall back to your
machine's out-of-tree default credentials.

### Worked example: web app + database emulator + cloud credentials

An app whose `npm run dev` starts a database emulator, the web server, and a
cloud auth proxy — and whose `.env` sets a relative-path service-account key
— integrates like this:

1. Keep the emulator running once (your normal dev session already starts it
   on its fixed port).
2. Point the pane at just the web server, tell it to use the shared emulator,
   and blank the in-repo key so cloud SDKs fall back to machine ADC:

```jsonc
{
  "dev": "npm run dev:web",            // web server only — NOT the bundle
  "install": "npm install",
  "copy": [".env", ".env.local"],      // carry app config/secrets, but not the key file
  "env": {
    "FIRESTORE_EMULATOR_HOST": "127.0.0.1:8080",   // reach the shared emulator
    "GOOGLE_APPLICATION_CREDENTIALS": ""           // fall back to ~/.config/gcloud ADC
  }
}
```

Result: no credential file is copied into any pane, each pane's database
points at the one shared emulator, and every other cloud call authenticates
via your machine-wide ADC. (Prerequisite: you've done your cloud CLI's
"application default login" so that ADC exists — the same setup your app
already needs locally.)

### Checklist for porting sidebranch into an app

1. **What does your dev command start?** If it's more than one server, split
   off the singletons.
2. **Run the singletons once** (or confirm your normal dev session does).
3. **Point `dev` at the single per-pane server**; make sure it honors `PORT`
   (or use `{port}`).
4. **`copy` the untracked files** the app needs — except secrets you can
   reach another way.
5. **For each service the app talks to**, decide: shared instance (`env`
   points at it), machine-wide credential (free), or copied file (`copy`).
6. **Blank any in-repo relative credential paths** with `"env": { "VAR": "" }`.
7. **`npx sidebranch doctor`**, then `start`, then open a pane.

### Prompt your coding agent to do it

Paste this into Claude Code / Cursor / your agent of choice, from your repo
root — it produces a `.sidebranch.json` tailored to your stack:

```text
Integrate sidebranch (a local PR-review sidecar) into this app. Steps:
1. Read package.json (or the equivalent) and identify the dev command(s).
   List every process and fixed port the normal dev workflow starts —
   web server, database/emulator, proxies, workers.
2. Identify which of those are singletons (fixed ports, shared state) vs the
   single web server that actually renders the app.
3. Find every credential/secret the app loads locally and where it comes
   from: in-repo relative-path files, machine-wide locations (~/.config,
   ~/.aws), or environment variables.
4. Write a .sidebranch.json where:
   - "dev" runs ONLY the web server, honoring the PORT env var (or {port}),
   - "copy" lists the untracked files the app needs at runtime,
   - "env" points the pane at the shared singletons and blanks ("") any
     in-repo relative credential paths so SDKs fall back to machine defaults.
5. Add the widget to the app's HTML/layout, gated to development only:
   <script src="http://localhost:49400/widget.js" defer></script>
6. Tell me exactly which singleton processes I must run once myself before
   using panes, and any one-time credential setup (e.g. cloud ADC login).
Do not modify my existing dev scripts or app code beyond adding the widget tag.
```

## Compare view

`http://localhost:49400/shell` (or the **Compare A/B** button):

- **Side by side** — both panes rendered live, one width control drives
  both viewports in lockstep (slider + 375/768/1280 presets).
- **Blend diff** — panes stacked with `mix-blend-mode: difference`;
  identical pixels go black, any change glows.
- **Layer diff** — stacked with an opacity slider on the top pane.
- **⇄ Swap** exchanges the panes' branches.

Scroll/interaction sync between frames is deliberately out of scope — the
stacked modes cover "did anything move?" and the side-by-side mode covers
"how does it behave?", without proxying or script injection into your app.

### If a pane says it "refuses to be embedded"

The iframes point straight at the pane dev servers, and those are a different
origin from this page — same-origin is per *port*, so `localhost:49400`
(the compare view) and `localhost:4410` (a pane) are as foreign to each other
as two different domains. An app that sends `X-Frame-Options: SAMEORIGIN` or a
`frame-ancestors` list that doesn't name the daemon will refuse to render here.

sidebranch detects this when the pane starts and tells you which header did it,
rather than showing a blank rectangle. Two ways out:

- **Stop sending the header in development.** In Next.js that usually means a
  `headers()` entry in `next.config.js` or a line in middleware — make it
  conditional on `process.env.NODE_ENV === "production"`. Same idea for a
  Helmet/`frameguard` setup in Express.
- **Or don't embed it:** use **Open in new tab** from the widget, or **Open A**
  from the shell. Everything else about the pane works normally; only the
  side-by-side and blend views need the frame.

The pane's own dev server is untouched either way — sidebranch never rewrites
your app's responses.

## Non-goals and guarantees

- sidebranch never runs a mutating git command against your primary
  working tree. No stash, no reset, no checkout — reads only.
- A dirty *pane* (someone edited a review worktree by hand) fails safe:
  the switch is refused until you explicitly opt into discarding, and only
  files inside that pane are affected.
- Worktrees live under `~/.sidebranch/`, outside your repo, so file
  watchers and tooling in your main tree never see them.

## Stopping and cleanup

`sidebranch stop` shuts down the daemon and its pane dev servers from any
terminal — you don't have to find the tab it's running in:

```sh
sidebranch stop
```

Pane worktrees deliberately survive a stop, so the next `start` reuses them
instead of re-installing everything. That means a pane still holds whatever
branch it last checked out, and git refuses to check out a branch that is
already checked out somewhere else:

```
fatal: 'main' is already used by worktree at '/Users/you/.sidebranch/projects/.../panes/a'
```

`sidebranch clean` removes those worktrees:

```sh
sidebranch clean           # lists panes, asks to confirm, then removes them
sidebranch clean --pane a  # target a single pane
sidebranch clean --yes     # skip the confirmation prompt (for scripts/agents)
```

`clean` refuses to run while a daemon is serving this repo — removing a
worktree out from under a running dev server would leave it serving a
directory that no longer exists. Run `stop` first; `clean` will tell you if
you haven't.

Both commands work on a record the daemon writes to
`~/.sidebranch/projects/<repo>/daemon.json`. If a daemon is killed outright
(`kill -9`, a closed terminal), that record is left behind — the next `stop`,
`start`, or `doctor` notices it isn't real and clears it. Neither command
will ever signal a process it hasn't confirmed is a sidebranch daemon, so a
stale record whose pid the OS has since recycled is harmless.

## Commands

```
sidebranch init      write starter config
sidebranch start     run the daemon (--port N, default 49400)
sidebranch stop      stop the daemon serving this repo
sidebranch clean     remove stale pane worktrees for this repo (--pane, --yes)
sidebranch doctor    environment checks (including daemon status)
```

## Development

```sh
node --test test/*.test.js
```

The suite covers the security gauntlet (token, Host/Origin gating, hostile
ref names), the full worktree lifecycle against real fixture repos, and an
end-to-end run that boots two panes on two branches and asserts both serve.

## License

MIT — see [LICENSE](LICENSE).

One exception: the bundled UI font (`src/assets/geist-pixel.woff2`) is a
modified build of [Geist Pixel](https://github.com/vercel/geist-font) under
the SIL Open Font License 1.1, not MIT. Its license, copyright notices, and
the modifications made are recorded in
[`src/assets/geist-pixel.LICENSE.txt`](src/assets/geist-pixel.LICENSE.txt).
