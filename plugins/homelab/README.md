# homelab

Homelab infrastructure management skills for Claude Code. Provides domain-specific knowledge and CLI workflows for managing homelab services.

## Skills

### authentik-api

Interact with Authentik SSO via the `ak` CLI, `ak-setup-oidc`, and the REST API. Covers the identity tier model, authentication patterns, and standard procedures for managing users, groups, applications, and OIDC providers.

Activates on: `authentik`, `SSO`, `OIDC setup`, `forward auth`, `proxy provider`, `ak list`, `ak-setup-oidc`

## Prerequisites

- `ak` and `ak-setup-oidc` scripts (in `home-orchestration/scripts/`)
- `op` (1Password CLI) for token retrieval
- `jq` for JSON processing
- `curl` for API calls

## Usage

Skills activate automatically based on conversation context:

```
> List all Authentik applications
> Set up OIDC for a new service
> Audit which groups can access which apps
> Add a new service account to Authentik
```
