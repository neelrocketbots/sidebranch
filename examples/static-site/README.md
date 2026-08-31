# Minimal example

Any repo + any server. From a git repo containing an index.html:

    cp .sidebranch.json <your-repo>/
    cd <your-repo> && npx sidebranch start

Add to index.html:

    <script src="http://localhost:49400/widget.js" defer></script>

Serve your own tree however you like (e.g. `python3 -m http.server 8000`),
open http://localhost:8000, and use the pill to load branches into panes.
