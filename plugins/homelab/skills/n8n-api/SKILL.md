---
name: n8n-api
description: Use when querying or managing n8n workflows — listing, creating, activating, deactivating workflows, managing tags and credentials. Triggers on "n8n", "workflow automation", "n8n workflow", "n8n api", "activate workflow", "deactivate workflow".
---

# n8n Workflow Automation API

## Wiki References (Read Before Modifying Workflows)

- **Service overview**: `https://wiki.lilbro.cloud/homelab/services/n8n.md`

## MCP Tools

n8n is also available via MCP tools at `mcp-lan.lilbro.cloud/n8n/mcp`. Prefer MCP tools when available in the session — fall back to restish/curl for operations MCP doesn't cover.

## Authentication

There is no dedicated `n8n` CLI wrapper script like `ak` or `harbor` — restish and curl are the options.

### From OpenClaw agents

```bash
restish n8n <operation>
```

The wrapper injects the API key from 1Password (`N8N API Key - lil-claw`).

### From local dev

```bash
curl -H "x-n8n-api-key: $(op item get 'N8N API Key' --vault homelab --field password --reveal)" \
  https://n8n.lilbro.cloud/api/v1/workflows
```

Base URL: `https://n8n.lilbro.cloud/api/v1`

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/workflows` | List all workflows |
| GET | `/workflows/{id}` | Get workflow details |
| POST | `/workflows` | Create workflow |
| PUT | `/workflows/{id}` | Update workflow |
| DELETE | `/workflows/{id}` | Delete workflow |
| POST | `/workflows/{id}/activate` | Activate workflow |
| POST | `/workflows/{id}/deactivate` | Deactivate workflow |
| GET | `/credentials` | List credentials (names only, no secrets) |
| GET | `/tags` | List tags |

### Known Quirk

`PUT /workflows/{id}` returns 400 if `settings.errorWorkflow` is included in the payload. Set the error workflow via the n8n web UI instead.

## Common Workflows

### List all workflows and their active status

```bash
curl -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/workflows | jq '[.data[] | {id, name, active}]'
```

### Get workflow details

```bash
curl -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/workflows/<id>
```

### Activate / deactivate a workflow

```bash
curl -X POST -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/workflows/<id>/activate

curl -X POST -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/workflows/<id>/deactivate
```

### List credentials and tags

```bash
curl -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/credentials | jq '[.data[] | {id, name, type}]'

curl -H "x-n8n-api-key: $N8N_API_KEY" \
  https://n8n.lilbro.cloud/api/v1/tags | jq '.data'
```

## Web UI

n8n has a visual workflow editor at `https://n8n.lilbro.cloud` — use it for complex workflow creation and the error workflow setting.

## Write Operations — Require User Approval

Creating, updating, or deleting n8n workflows changes production automation. Always confirm with the user before:
- Creating workflows (`POST /workflows`)
- Updating workflows (`PUT /workflows/{id}`)
- Deleting workflows (`DELETE /workflows/{id}`)
- Activating or deactivating workflows
