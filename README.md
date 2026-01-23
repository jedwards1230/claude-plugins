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
| [remember](plugins/remember/) | Memory management for storing and retrieving knowledge |

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
