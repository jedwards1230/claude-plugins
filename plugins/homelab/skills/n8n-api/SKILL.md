---
name: n8n-api
description: Use when querying or managing n8n workflows — listing, creating, activating, deactivating workflows, managing tags and credentials. Triggers on "n8n", "workflow automation", "n8n workflow", "n8n api", "activate workflow", "deactivate workflow".
---

# n8n Workflow Automation API

## Wiki References

- **Service overview**: `https://wiki.lilbro.cloud/homelab/services/n8n.md`

## Preferred: `n8n` CLI wrapper

The homelab plugin ships an `n8n` wrapper at `plugins/homelab/scripts/n8n` (same style as `ak` / `harbor`). Prefer it over raw curl — it handles auth, pagination, and the `PUT /workflows/{id}` sanitization gotcha automatically.

```bash
n8n list [<resource>] [--filter <jq>] [--query <qs>] [--raw]
n8n get  [<resource>] <id>
n8n create [<resource>] <json|@file>
n8n update <id> <json|@file>              # workflow PUT, auto-sanitized
n8n delete [<resource>] <id> [--yes|-y]
n8n activate <id> | n8n deactivate <id>
n8n tags [list|create <name>]
n8n executions [--query <qs>]
n8n GET|POST|PUT|PATCH|DELETE <path> [body]   # raw passthrough
n8n help
```

`<resource>` defaults to `workflows` when omitted. Known resources: `workflows`, `tags`, `executions`, `variables`, `users`, `projects`, `source-control`, `audit`.

### Common patterns

```bash
# List all workflows, id/name/active only
n8n list --filter '[.[] | {id, name, active}]'

# Get a workflow
n8n get nwLDnLcmPpsYnc3D

# Update a workflow from a file (auto-sanitized)
n8n update nwLDnLcmPpsYnc3D @/tmp/workflow.json

# Activate / deactivate
n8n activate nwLDnLcmPpsYnc3D
n8n deactivate nwLDnLcmPpsYnc3D

# Tag ops
n8n tags
n8n tags create "domain:wiki"
```

## Alternative: MCP tools

n8n is also exposed via MCP at `mcp-lan.lilbro.cloud/n8n/mcp`. Use MCP tools when they cover the operation — fall back to the `n8n` wrapper otherwise.

## Authentication

The wrapper auto-fetches `N8N_API_KEY` from 1Password (`N8N API Key` in `homelab` vault, `credential` field — falls back to `password` for older items).

Two separate API keys exist in 1Password for different environments:

| Environment | 1Password Item | Vault | How it's used |
|-------------|---------------|-------|---------------|
| **Local dev** (laptop) | `N8N API Key` | `homelab` | Wrapper reads this automatically |
| **OpenClaw agents** (K8s) | `N8N API Key - lil-claw` | `home-agent` | Injected by `/nfs/openclaw/bin/restish` wrapper |

To override, export `N8N_API_KEY` (and optionally `N8N_URL`) before calling the wrapper.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/workflows` | List all workflows |
| GET | `/workflows/{id}` | Get workflow details |
| POST | `/workflows` | Create workflow |
| PUT | `/workflows/{id}` | Update workflow (see sanitization below) |
| DELETE | `/workflows/{id}` | Delete workflow |
| POST | `/workflows/{id}/activate` | Activate workflow |
| POST | `/workflows/{id}/deactivate` | Deactivate workflow |
| GET | `/tags` | List tags |
| POST | `/tags` | Create tag |
| GET | `/executions` | List executions |

Note: n8n's public API does **not** expose `GET /credentials`. Use the web UI to inspect credentials; use raw passthrough (`n8n POST credentials`, `n8n DELETE credentials/<id>`) to manage them.

### PUT /workflows/{id} sanitization

n8n's public API rejects any field outside `{name, nodes, connections, settings, staticData}` with `request/body must NOT have additional properties`. It also rejects `settings.errorWorkflow`.

The `n8n update` subcommand auto-whitelists these five fields and drops `settings.errorWorkflow`. Pass `--no-sanitize` to disable (only useful for debugging). Set error workflows via the n8n web UI.

## Raw curl fallback

If the wrapper is unavailable, the equivalent raw pattern is:

```bash
export N8N_API_KEY=$(op item get 'N8N API Key' --vault homelab --field credential --reveal)
curl -H "x-n8n-api-key: $N8N_API_KEY" https://n8n.lilbro.cloud/api/v1/workflows | jq '.data'
```

## Web UI

n8n has a visual workflow editor at `https://n8n.lilbro.cloud` — use it for complex workflow creation and the error workflow setting.

## Write Operations — Require User Approval

Creating, updating, or deleting n8n workflows changes production automation. Always confirm with the user before:
- `n8n create` / `n8n update` / `n8n delete`
- `n8n activate` / `n8n deactivate`
