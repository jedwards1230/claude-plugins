# screenshotter

A generic, autonomous UI screenshotter agent. Point it at a running UI — a desktop
app, a web page, a TUI, any on-screen view — and it figures out how to capture on the
current platform, brings the target to the requested state, takes the shot, **verifies
the frame is real and is the view you asked for**, and returns the image with a concise
description. It keeps the noisy navigate/capture/retry loop internal, so the parent
conversation stays clean.

## Install

```bash
/plugin marketplace add jedwards1230/claude-plugins
/plugin install screenshotter@jedwards1230-plugins
```

## Usage

The `screenshotter` agent activates on screenshot/UI-capture requests:

```
> Screenshot the settings page so I can check the new toggle
> Show me what the dashboard looks like
> Do a UI review of the main screens — layout and spacing
> Validate that the empty-state renders on the library page
```

### Three modes

| Mode | Triggered by | What it does |
|------|--------------|--------------|
| **Baseline** | a plain "show me / screenshot X" | capture the view, return the image + a description |
| **UI review** | "review the UI", "check layout/spacing/design" | capture the key views, then give structured design feedback |
| **Feature validation** | a feature name or specific state | drive the feature through its states, screenshot each, report pass/fail |

### How it stays reliable

- **Self-verifies every capture** — detects blank/stale frames (tiny files, byte-identical
  shots), checks the two real causes (a window covering the target; a stale duplicate
  instance), and retries up to 3× before recording a failure.
- **Confirms the right view** — accepts a shot only after it can name the UI elements it
  expects for that view, so a silently-failed navigation never gets filed under the wrong
  label.
- **Two output modes** — returns images inline for ≤2 shots; for larger batches it saves to
  a temp dir and returns a manifest (view → path → status) so it doesn't flood context.

## Capture methods

The agent discovers how to capture based on the target and platform:

- **Web pages** — via a Playwright MCP server **you configure in the project** (see
  [Web capture setup](#web-capture-setup-playwright-mcp) below). Preferred for anything in
  a browser.
- **macOS** — `screencapture`.
- **Linux** — `grim` (Wayland) or `scrot` / `spectacle` / ImageMagick `import` (X11).
- **Windows** — PowerShell screen capture.
- **App-specific** — any screenshot command or MCP tool the project provides.

## Web capture setup (Playwright MCP)

This plugin is **agent-only** — it does **not** bundle an MCP server. To screenshot web
pages, the agent uses a **Playwright MCP server configured in your project**, which exposes
the `mcp__playwright__browser_*` tools it drives to navigate, size the viewport, wait for
content, and screenshot. Configuring it in the project (rather than bundling it) keeps the
tool names stable (`mcp__playwright__*`) and lets each repo pick its own browser/headed/
version settings — and the same server is then available to everything else in the repo,
not just this agent.

**Only needed for web capture.** Native capture (desktop apps, TUIs) uses your platform's
screenshot tool and needs none of this.

**Setup:** add a `.mcp.json` at your project root. A ready-to-copy template ships with the
plugin as [`.mcp.json.example`](.mcp.json.example):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--browser", "firefox", "--headless"]
    }
  }
}
```

Adjust to taste — drop `--headless` to watch the browser, swap `firefox` for `chromium`/
`webkit`, or pin `@playwright/mcp@<version>`. If your repo already has a `playwright` server
in `.mcp.json`, you're done — the agent uses it as-is.

**Prerequisites for the web path:**

- **Node.js** (the server runs via `npx @playwright/mcp@latest`).
- A one-time browser install: `npx playwright install firefox` (or whichever browser you
  configured). Without it, the first web capture fails with a "browser not installed" error.

If a web capture is requested and no Playwright tools are present, the agent won't spin — it
tells you exactly what to add (this `.mcp.json` + the browser install) and stops.

## Tools

The agent **inherits your session's full tool set** — it declares no `tools:` allowlist.
That's deliberate: capture and UI control vary wildly per project, so the agent needs to
reach whatever your session exposes — a project-configured Playwright MCP server, your
platform's screenshot command, and **any project-specific MCP tools that drive your app's
UI**. Your normal permission settings still gate everything it runs.

## Model

The agent inherits your session's model (no forced tier). **Haiku** is typically an
effective and economical choice for its mechanical capture loop.
