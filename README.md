# Claude Plugins

Private marketplace for reusable Claude Code plugins.

## Installation

```bash
# Add marketplace
/plugin marketplace add jedwards1230/claude-plugins

# Install a plugin
/plugin install dream@jedwards1230-plugins
```

## Available Plugins

| Plugin | Description |
|--------|-------------|
| [dream](plugins/dream/) | Basic-memory knowledge base maintenance |
| [git-worktree](plugins/git-worktree/) | Git worktree workflow management for parallel branch development |
| [grafana-dashboards](plugins/grafana-dashboards/) | Grafana dashboard creation and management for Kubernetes |
| [pr-checker](plugins/pr-checker/) | Check PR CI status, reviewer verdicts, merge conflicts, and review threads |
| [project-manager](plugins/project-manager/) | Project management across multiple GitHub repos — triage, planning, tracking |
| [remember](plugins/remember/) | Memory management for storing and retrieving knowledge |
| [review-team](plugins/review-team/) | Dynamic review team composition with specialized agents |

## Development

```bash
# Add marketplace from local path
/plugin marketplace add ./tooling/claude-plugins

# Validate structure
/plugin validate ./tooling/claude-plugins
```

## Adding a New Plugin

1. Create directory under `plugins/<plugin-name>/`
2. Add `.claude-plugin/plugin.json` with metadata
3. Add commands, skills, or hooks as needed
4. Update `marketplace.json` with new plugin entry
