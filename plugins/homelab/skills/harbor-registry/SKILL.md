---
name: harbor-registry
description: Use when managing Harbor container registry — listing projects, creating proxy caches, managing registry endpoints, checking health. Triggers on "harbor", "registry", "proxy cache", "container registry", "harbor project", "harbor registry", "registry.lilbro.cloud".
---

# Harbor Registry Operations

## Wiki References

No Harbor wiki page exists yet. Check `https://wiki.lilbro.cloud/homelab/services/` for updates.

## Authentication

Credentials in 1Password. Set before any API call:

```bash
export HARBOR_USER=$(op read "op://homelab/Harbor Registry/username")
export HARBOR_PASS=$(op read "op://homelab/Harbor Registry/password")
```

Can also override with `HARBOR_USER` and `HARBOR_PASS` env vars directly.

Base URL: `https://registry.lilbro.cloud/api/v2.0`

## CLI Tool

The `harbor` script is bundled with this plugin at `${CLAUDE_PLUGIN_ROOT}/bin/harbor` — invokable as the bare command `harbor` since `bin/` is on PATH while the plugin is enabled. It wraps the Harbor v2.0 API with basic auth.

### Commands

```bash
# Health and system info
harbor status

# Projects
harbor project ls                          # list all (name, type, repo count, public, proxy cache)
harbor project get <name>                  # project details + proxy cache registry info
harbor project create-proxy <name> <url>   # create proxy cache (requires existing registry endpoint)
harbor project delete <name>               # delete with confirmation

# Registry endpoints
harbor registry ls                         # list endpoints (ID, name, type, URL, status)
harbor registry get <id>                   # endpoint details
harbor registry create <name> <url>        # create with auto-type detection
harbor registry delete <id>               # delete with confirmation
```

### Auto-Type Detection for Registry Endpoints

`harbor registry create` detects the registry type from the URL:

| URL Pattern | Type |
|-------------|------|
| `docker.io` / `hub.docker.com` | `docker-hub` |
| `ghcr.io` | `github-ghcr` |
| `gcr.io` | `google-gcr` |
| `quay.io` | `quay` |
| `*.dkr.ecr.*.amazonaws.com` | `aws-ecr` |
| Other | `docker-registry` |

## Common Workflows

### Check health

```bash
harbor status
```

### List projects and their proxy cache config

```bash
harbor project ls
harbor project get <name>
```

### Set up a new proxy cache

Create the registry endpoint first, then the proxy cache project:

```bash
# 1. Create registry endpoint
harbor registry create "GitHub Container Registry" "https://ghcr.io"

# 2. Create proxy cache project pointing to that endpoint
harbor project create-proxy ghcr-proxy "https://ghcr.io"
```

### Manage registry endpoints

```bash
harbor registry ls
harbor registry get <id>
```

## Web UI

Harbor also has a web UI at `https://registry.lilbro.cloud` for visual management.

## Write Operations — Require User Approval

Creating, updating, or deleting Harbor resources changes the production registry. Always confirm with the user before:
- Creating proxy cache projects (`harbor project create-proxy`)
- Creating registry endpoints (`harbor registry create`)
- Deleting any resource (`harbor project delete`, `harbor registry delete` — both have confirmation prompts)
