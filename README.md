# Claude Plugins

Public marketplace for reusable Claude Code plugins.

Plugins that bake in personal workflows, hardcoded repo lists, or homelab-specific conventions live in the separate [`claude-plugins-private`](https://github.com/jedwards1230/claude-plugins-private) marketplace.

## Installation

```bash
# Add marketplace
/plugin marketplace add jedwards1230/claude-plugins

# Install a plugin
/plugin install git-tooling@jedwards1230-plugins
```

## Available Plugins

| Plugin | Description |
|--------|-------------|
| [git-tooling](plugins/git-tooling/) | Git tooling — worktree workflows, PR-aware push reminders, and on-demand CI status watching |
| [go-quality](plugins/go-quality/) | Go quality gates — auto-format, vet, test, and lint on every turn |
| [grafana-dashboards](plugins/grafana-dashboards/) | Grafana dashboard creation and management for Kubernetes |

## Development

From inside this repo's clone, run:

```bash
# Add marketplace from local path
/plugin marketplace add .

# Validate structure
/plugin validate .
```

## Adding a New Plugin

1. Create directory under `plugins/<plugin-name>/`
2. Add `.claude-plugin/plugin.json` with metadata
3. Add commands, skills, or hooks as needed
4. Update `marketplace.json` with new plugin entry
