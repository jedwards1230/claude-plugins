# Dream Plugin

Basic-memory knowledge base maintenance and optimization.

## Usage

```bash
/dream        # Comprehensive mode - scans EVERY file, interactive
/dream --ci   # CI mode - diff-targeted, non-interactive, conservative
```

## Modes

| Mode | Args | Behavior |
|------|------|----------|
| **Comprehensive** | (none) | Scans every file in `.basic-memory/`, can make major changes, interactive |
| **CI** | `--ci` | Only examines recent git changes, conservative changes only, non-interactive |

## What it does

- Archives completed plans and resolved issues
- Consolidates duplicate notes
- Fixes broken `memory://` links
- Updates metadata and frontmatter
- Reorganizes scattered topics into categories

## GitHub Actions Integration

The workflow uses:
- **Scheduled (nightly)**: `/dream --ci` - quick scan of recent changes
- **Manual dispatch**: `/dream` - comprehensive review of entire KB

## Requirements

- basic-memory MCP server configured
- `.basic-memory/` directory in your project
