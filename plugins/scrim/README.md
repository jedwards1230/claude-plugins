# scrim

A projection surface for coding agents: write plain HTML/CSS/JS files into a
canvas directory and [`scrim`](https://github.com/jedwards1230/scrim) serves
them at a local URL with instant live-reload, so a human can watch from any
browser on the machine (or LAN, with `--host`).

This plugin is a thin skill wrapper around the standalone `scrim` binary — it
doesn't bundle the tool itself.

## Install

```
/plugin install scrim@jedwards1230-plugins
```

Then install the `scrim` CLI separately:

```
go install github.com/jedwards1230/scrim@latest
```

or grab a release binary from
[github.com/jedwards1230/scrim/releases](https://github.com/jedwards1230/scrim/releases).

## What it does

A `scrim` skill teaches Claude the CLI surface (`add`, `path`, `list`, `open`,
`rm`, `status`, `stop`) and the core loop: `scrim add <id>` → Write/Edit files
in the printed directory → the browser reloads itself → always surface the
canvas URL back to the user. It also covers the security defaults (capability
tokens on printed URLs, loopback-only binding by default) and how to verify a
canvas actually rendered (Playwright MCP screenshot preferred, `curl` as a
markup-only fallback).

**Dependencies:** the `scrim` binary (not bundled — see Install above).
