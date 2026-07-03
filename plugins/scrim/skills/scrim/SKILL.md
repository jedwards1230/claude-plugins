---
name: scrim
description: Use when you need to show the user something visual — a live HTML/CSS/JS preview, a canvas, a diagram, a mockup, or any rendered page — and there's no existing app to preview it in. scrim gives you a projection surface at a local URL that live-reloads as you write files, so the user can watch it update in their browser. Triggers on "show me a preview", "render this as HTML", "live preview", "canvas", "projection surface", "scrim".
---

# scrim

`scrim` is a small Go CLI + self-starting daemon that serves a directory of
plain HTML/CSS/JS at a local URL and live-reloads the browser tab whenever you
write to it. Use it when you want the user to *watch something render* —
a diagram, a mockup, a data view, a game-of-life toy — and no other app
already provides that preview surface (don't reach for it to serve a real
project's dev server; use that project's own tooling for that).

## Availability

Check before use: `command -v scrim`. If missing, point the user at
installation — a release binary from `github.com/jedwards1230/scrim/releases`,
or `go install github.com/jedwards1230/scrim@latest` if they have Go tooling.
Don't try to install it yourself; surface the command and let the user decide.

## Workflow

1. `scrim add <id> [--title T]` — starts the daemon if it isn't already
   running, creates (or reuses) a canvas, and prints the canvas directory plus
   its URL.
2. Write/Edit plain `.html`/`.css`/`.js` files directly into that printed
   directory (an `index.html` is the entry point). No build step, no
   framework — the daemon serves the files as-is and injects a small
   live-reload script.
3. Every save triggers a full-page reload in any open browser tab via SSE —
   you don't re-run anything to see the next version.
4. **Always surface the canvas URL to the user** after `add` (and again after
   major updates) so they know where to look. Don't assume they remember it
   from a previous turn.

Other verbs:

```
scrim path <id>    # print the canvas dir again (e.g. after losing track of it)
scrim list         # all canvases + URLs + daemon status
scrim open [<id>]  # open the canvas (or the canvas index) in a browser
scrim rm <id>      # delete a canvas
scrim status       # daemon health, port, idle countdown, token state
scrim stop         # stop the daemon now (canvas files persist on disk)
```

`scrim serve` runs the daemon in the foreground — that's for containers/systemd,
not normal use; every other verb self-starts the daemon as needed.

## Security notes

- By default every printed/opened URL carries a capability token
  (`?t=...` → cookie); requests without it get a 401. Don't strip the token
  off a URL you hand to the user.
- The daemon binds to `127.0.0.1` by default — only reachable from the local
  machine. `--host` opts into binding beyond loopback for LAN viewing (e.g. a
  second device); pair it with `--no-auth` only on a trusted LAN, and say so
  explicitly when you suggest it.
- There's no cross-network relay — Tailscale or similar handles that if the
  user wants to view from off-network.

## Closing the loop

Don't just write files and declare done — verify what actually rendered:

- **Preferred**: use Playwright MCP (if available) to navigate to the canvas
  URL and take a screenshot. This catches rendering/JS errors a file read
  can't.
- **Fallback** (no browser tooling available): `curl` the canvas URL to sanity
  check the markup served, but note to the user that you haven't visually
  confirmed it.

If the screenshot shows something broken, fix the files and reload the
screenshot rather than asking the user to check for you.
