# Claude Plugins

Public marketplace for reusable Claude Code plugins.

Plugins with personal or homelab-specific conventions are maintained separately in a private marketplace.

## Installation

```bash
/plugin marketplace add jedwards1230/claude-plugins
/plugin install <plugin-name>@jedwards1230-plugins
```

Browse [`plugins/`](plugins/) for what's available; for example, [`animated-short`](plugins/animated-short/)
makes short narrated animated films (explainers, stories, promos) from one round of questions.

## Development

From a local clone:

```bash
/plugin marketplace add .
/plugin validate .
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, commit, validation, and release conventions.
