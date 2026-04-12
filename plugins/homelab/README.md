# homelab

Homelab infrastructure management skills for Claude Code. Provides domain-specific knowledge and CLI workflows for managing homelab services.

## Skills

### authentik-api

Interact with Authentik SSO via the `ak` CLI, `ak-setup-oidc`, and the REST API. Covers the identity tier model, authentication patterns, and standard procedures for managing users, groups, applications, and OIDC providers.

Activates on: `authentik`, `SSO`, `OIDC setup`, `forward auth`, `proxy provider`, `ak list`, `ak-setup-oidc`

### harbor-registry

Manage Harbor container registry via the `harbor` CLI wrapper. List projects, create proxy caches, manage registry endpoints, and check health.

Activates on: `harbor`, `registry`, `proxy cache`, `container registry`, `harbor project`, `harbor registry`, `registry.lilbro.cloud`

### n8n-api

Query and manage n8n workflow automation via the REST API. List, create, activate, and deactivate workflows. Prefer MCP tools when available, fall back to restish/curl.

Activates on: `n8n`, `workflow automation`, `n8n workflow`, `n8n api`, `activate workflow`, `deactivate workflow`

## Prerequisites

- `ak` and `ak-setup-oidc` scripts (in `home-orchestration/scripts/`)
- `harbor` script (in `home-orchestration/scripts/`)
- `op` (1Password CLI) for token/credential retrieval
- `jq` for JSON processing
- `curl` for API calls
- `restish` (optional, for n8n from openclaw agents)

## Usage

Skills activate automatically based on conversation context:

```
> List all Authentik applications
> Set up OIDC for a new service
> Check Harbor registry health
> Set up a proxy cache for ghcr.io
> List all n8n workflows
> Activate an n8n workflow
```
