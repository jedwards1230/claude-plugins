---
name: authentik-api
description: Use when querying or modifying Authentik SSO — listing users, groups, applications, providers, creating OIDC apps, auditing access policies, setting up forward auth or proxy providers, managing service accounts and policy bindings. Relevant for "authentik", "SSO", "OIDC setup", "identity provider", "ak list", "ak setup-oidc", "forward auth", "proxy provider", "policy binding", "service account".
---

# Authentik API Operations

## Wiki References (Read Before Modifying Identity or App Config)

When creating apps, changing group bindings, or modifying the identity model, read these wiki pages for the current state of truth:

- **Identity standard** (tiers, groups, naming): `https://wiki.lilbro.cloud/homelab/authentik-identity-standard.md`
- **Service overview** (infra, auth patterns): `https://wiki.lilbro.cloud/homelab/services/authentik.md`

These pages are maintained independently and may be newer than this skill. Not needed for simple read queries.

## Identity Model

Users are assigned to **one** tier group. Parent-group inheritance grants access to all tiers below.

```
Tier 0: guests         → public-facing apps (none yet)
  └─ Tier 1: friends   → social/shared apps
       └─ Tier 2: family   → home apps (wiki, media, chat)
            └─ Tier 3: admins   → infra tools (grafana, prometheus, code-server)
```

`authentik Admins` is a separate built-in superuser group (tier 4 equivalent).

Non-human identities (agents, bots, CI) go in a flat `service-accounts` group with **no parent** — they never inherit human-tier access. Apps needing both human and agent access bind to their tier **plus** `service-accounts`.

### Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Tier groups | lowercase, single word | `family`, `admins`, `guests` |
| Service account users | `<service>-<role>` | `kova-agent`, `github-actions-otlp` |
| OAuth2 providers | `Provider for <App Name>` | `Provider for Home Wiki` |
| Applications | Title case, match service name | `Home Wiki`, `MCP Proxy` |
| 1Password items | `Authentik - <User> - <Context>` | `Authentik - Justin - AKAdmin` |

## Authentication Patterns in K8s

Three patterns are used across services:

| Pattern | Middleware/Config | Services |
|---------|-------------------|----------|
| **Forward auth** (Traefik) | `redirect-lan-auth` middleware | Code-Server, Prometheus |
| **Native OAuth2/OIDC** | Built-in login button | Grafana, Harbor |
| **MCP OAuth 2.1** | OAuth2 Proxy + JWT validation | MCP Proxy (`mcp.lilbro.cloud`) |

Forward auth requires: Authentik Proxy Provider, ExternalName service to outpost, ingress path for `/outpost.goauthentik.io`.

## API Authentication

Token is auto-fetched from 1Password when `AUTHENTIK_TOKEN` is not set. To override:

```bash
export AUTHENTIK_TOKEN=$(op item get "Authentik homelab-token" --vault homelab --field token --reveal)
```

Base URL: `https://auth.lilbro.cloud`

## CLI Tools

Unified `ak` CLI in the home-orchestration repo at `scripts/ak`.

### `ak` — Authentik API CLI

Thin curl wrapper that mirrors `/api/v3` paths with resource aliases and auto-pagination.

```bash
ak list <resource> [--filter <jq>] [--query <qs>] [--raw]
ak get <resource> <id>
ak create <resource> <json|@file>
ak update <resource> <id> <json|@file>   # PUT (full replace)
ak patch <resource> <id> <json|@file>    # PATCH (partial)
ak delete <resource> <id> [--yes|-y]
ak setup-oidc <name> <redirect-uri> [options]
ak GET|POST|PATCH|PUT|DELETE <path> [body]  # raw passthrough
ak schema                                    # dump OpenAPI JSON
```

**Flags:**
- `--filter <jq>` — jq expression applied to `.results` array
- `--query <qs>` — querystring appended to URL (e.g. `search=foo&page_size=100`)
- `--raw` — skip jq formatting, print raw response (first page only)
- `--yes / -y` — skip delete confirmation prompt

**Notes:** `ak list` auto-paginates across all pages by default.

### Resource Aliases

| Alias | API Path |
|-------|----------|
| `applications` | `core/applications` |
| `groups` | `core/groups` |
| `users` | `core/users` |
| `tokens` | `core/tokens` |
| `flows` | `flows/instances` |
| `outposts` | `outposts/instances` |
| `providers/all` | `providers/all` |
| `providers/oauth2` | `providers/oauth2` |
| `providers/proxy` | `providers/proxy` |
| `certificate-keypairs` | `crypto/certificatekeypairs` |
| `property-mappings/scope` | `propertymappings/scope` |
| `blueprints` | `managed/blueprints` |

Unknown aliases pass through unchanged — you can use raw API paths directly.

### `ak setup-oidc` — Automated OIDC App Creation

Creates a complete OAuth2 provider + application, resolving all PKs dynamically (flows, scope mappings, signing key).

```bash
ak setup-oidc <name> <redirect-uri> [--slug <slug>] [--launch-url <url>] \
  [--description <text>] [--scopes <list>] [--sub-mode <mode>]
```

Example:
```bash
ak setup-oidc "Backstage" "https://backstage.lilbro.cloud/api/auth/authentik/handler/frame" \
  --slug backstage \
  --launch-url "https://backstage.lilbro.cloud" \
  --description "Developer portal"
```

Outputs `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PROVIDER_PK`, `APP_SLUG`, and `ISSUER` — ready to feed into 1Password or K8s secrets.

> **Note:** `ak-setup-oidc` still works as a deprecated wrapper and will be removed in a future release.

## Common Workflows

### Audit current state
```bash
ak list applications --filter '[.[].name]'
ak list groups --filter '[.[] | {name, pk, num_pk: .num_pk}]'
ak list users --query 'page_size=100' --filter '[.[] | {username, name, is_active}]'
ak list providers/all --filter '[.[] | {name, pk, assigned_application_name}]'
```

### Check policy bindings (which groups can access which apps)
```bash
ak list policies/bindings --filter '[.[] | {target, group_obj: .group_obj.name, enabled}]'
```

### Create OIDC app for a new service
```bash
ak setup-oidc "Service Name" "https://service.lilbro.cloud/callback" \
  --slug service-name \
  --launch-url "https://service.lilbro.cloud"
# Then store client_id/secret in 1Password
```

### Inspect a specific provider
```bash
ak get providers/oauth2 <pk>
```

## Standard Procedures

### Add a new app to Authentik

1. Create OAuth2/OpenID Provider — use `ak setup-oidc` for OIDC, or `ak create providers/proxy` for forward auth
2. Create Application bound to the provider
3. Add a group policy binding to the appropriate tier (see Identity Model above)
4. If agents need access, add `service-accounts` to the policy binding
5. Store `client_id`/`client_secret` in 1Password: `k8s-<namespace>-<service>-authentik-oidc`
6. Update the wiki identity standard page with the new app binding

### Add a new user

1. Create user in Authentik
2. Add to **one** tier group (the highest they need) — inheritance handles the rest
3. No need to add to multiple groups

### Add a new service account

1. Create user (username: `<service>-<role>`, e.g., `kova-agent`)
2. Add to `service-accounts` group
3. Create API token or OAuth2 client credentials as needed
4. Store credentials in 1Password: `Authentik - <name>`

## Write Operations — Require User Approval

Creating, updating, or deleting Authentik resources changes production SSO. Always confirm with the user before:
- Creating providers or applications (`ak create`, `ak setup-oidc`)
- Modifying group memberships or policy bindings (`ak patch`, `ak update`)
- Deleting any resource (`ak delete` — prompts for confirmation unless `--yes` is passed)
