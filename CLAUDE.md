# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: Use plugin-dev Skills First

Before creating or modifying plugins, invoke the appropriate `plugin-dev` skill (e.g., `/plugin-dev:create-plugin`, `/plugin-dev:skill-development`, `/plugin-dev:hook-development`). These skills provide best practices and validation patterns.

## Overview

Personal Claude Code plugin marketplace. Provides specialized skills and automation tools that extend Claude's capabilities.

## Commands

### CI/CD Validation

```bash
# Validate plugin versions were bumped when plugin files change
./scripts/check-plugin-versions.sh origin/main
```

This runs automatically on pushes to main that modify `plugins/` or `.claude-plugin/marketplace.json`.

### Plugin Installation (for users)

```bash
/plugin marketplace add jedwards1230/claude-plugins
/plugin list
/plugin install <plugin-name>
```

## Architecture

### Plugin Types

1. **Skill-based plugins** (e.g., `dream`) - Define workflows in markdown that Claude invokes via `/plugin-name` commands
2. **Hook-based plugins** - Run shell scripts on Claude Code events (SessionStart, PostToolUse)

### Plugin Structure

```
plugins/<plugin-name>/
├── .claude-plugin/
│   └── plugin.json          # Required: name, version, description, author
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md         # Workflow definition
│       ├── TEMPLATE.md      # Templates for the skill
│       └── STYLE.md         # Optional: style conventions
├── hooks/
│   └── hooks.json           # Hook definitions (SessionStart, PostToolUse)
├── scripts/                 # Shell scripts for hooks
└── .mcp.json                # Optional: bundled MCP server config
```

### Marketplace Registry

`.claude-plugin/marketplace.json` is the central registry. Every plugin must have an entry here (`name`, `source`, `description`). **Do not set `version` on marketplace entries** — the plugin manifest is authoritative, and setting it in both places silently ignores the marketplace value (see [plugins reference](https://code.claude.com/docs/en/plugins-reference#version-resolution-and-release-channels)).

## Contributing

### Adding a New Plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json` (with `version`)
2. Add skill or hook files following the structure above
3. Add an entry to `.claude-plugin/marketplace.json` (no `version` field)
4. Push triggers version validation CI

### Version Bumping Rules

When modifying an existing plugin:

1. Bump `version` in `plugins/<name>/.claude-plugin/plugin.json` — this is the only place plugin versions live
2. Bump `metadata.version` in `marketplace.json`:
   - **Major** (1.0.0 → 2.0.0): Plugin added/removed
   - **Minor** (1.0.0 → 1.1.0): Core metadata changes
   - **Patch** (1.0.0 → 1.0.1): Plugin version changes

### Dependencies

- **Runtime**: Claude Code CLI, gh auth (or GITHUB_TOKEN)
- **CI**: jq (JSON parsing)