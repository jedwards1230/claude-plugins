# Claude Plugins

Public marketplace for reusable Claude Code plugins.

Plugins that bake in personal workflows, hardcoded repo lists, or homelab-specific conventions live in the separate [`claude-plugins-private`](https://github.com/jedwards1230/claude-plugins-private) marketplace.

## Installation

```bash
/plugin marketplace add jedwards1230/claude-plugins
/plugin install <plugin-name>@jedwards1230-plugins
```

Browse [`plugins/`](plugins/) for what's available.

## Development

From a local clone:

```bash
/plugin marketplace add .
/plugin validate .
```
