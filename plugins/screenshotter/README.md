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

- **Web pages** — via the bundled Playwright MCP server (see below). Preferred for anything
  in a browser.
- **macOS** — `screencapture`.
- **Linux** — `grim` (Wayland) or `scrot` / `spectacle` / ImageMagick `import` (X11).
- **Windows** — PowerShell screen capture.
- **App-specific** — any screenshot command or MCP tool the project provides.

## Web capture (Playwright MCP)

This plugin **bundles** a Playwright MCP server (`.mcp.json`), so web-page capture works
as soon as the plugin is enabled — no extra MCP configuration required. It exposes the
`mcp__playwright__browser_*` tools the agent uses to navigate, size the viewport, wait for
content, and screenshot.

**Prerequisites for the web path:**

- **Node.js** (the server runs via `npx @playwright/mcp@latest`).
- A one-time browser install: `npx playwright install firefox` (the bundled server uses
  headless Firefox by default). Without it, the first web capture fails with a
  "browser not installed" error.

Native (non-browser) capture needs neither — it uses your platform's screenshot tool.

## Tools

The agent **inherits your session's full tool set** — it declares no `tools:` allowlist.
That's deliberate: capture and UI control vary wildly per project, so the agent needs to
reach whatever your session exposes — the bundled Playwright browser tools, your
platform's screenshot command, and **any project-specific MCP tools that drive your app's
UI**. Your normal permission settings still gate everything it runs.

## Model

The agent inherits your session's model (no forced tier). **Haiku** is typically an
effective and economical choice for its mechanical capture loop.
