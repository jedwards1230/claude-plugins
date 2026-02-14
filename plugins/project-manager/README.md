# project-manager

Project management plugin for multi-repo homelab ecosystem. Provides standardized triage, sprint planning, status tracking, and cleanup workflows using GitHub Issues and Project boards.

## Components

### Skill: `project-manager`

Defines PM standards — label taxonomy, triage workflow, sprint planning, cross-repo coordination, and status reporting. Loaded by both agents.

### Agent: `project-manager` (magenta)

Strategic agent that plans, triages, and prioritizes work.

**Autonomous**: Create issues, label, prioritize, add to boards, link cross-repo issues, generate status reports.

**Requires approval**: Closing/archiving issues, major priority changes (e.g., P2 → P0).

### Agent: `project-ops` (yellow)

Maintenance agent that closes resolved work and ensures project hygiene.

**Autonomous**: Close P1-normal/P2-low issues with merged PRs, archive completed board items, flag stale issues, remove resolved blockers.

**Requires approval**: Bulk operations (>5 issues), closing P0-critical issues (even with merged PRs).

## Setup

### 1. Install the plugin

```bash
/plugin install project-manager
```

### 2. Create labels across all repos

The skill includes a label setup script. Run it for each repo:

```bash
# Example for one repo
REPO="jedwards1230/home-orchestration"
gh label create "P0-critical" --repo $REPO --color "b60205" --description "Service down, data loss, security" --force
# ... (see SKILL.md for full script)
```

### 3. Create GitHub Project boards

```bash
gh project create --owner jedwards1230 --title "Homelab Infra"
gh project create --owner hagen-ai --title "Hagen Roadmap"
# ... one per repo
```

## Usage

```
# Triage new issues
"Triage the new issues in hagen"

# Sprint planning
"What should I work on next?"

# Status report
"Project status across all repos"

# Cleanup
"Clean up resolved issues in home-orchestration"

# Stale issue pruning
"Prune stale issues across all repos"
```

## Tracked Repos

| Repo | Owner | Scope |
|------|-------|-------|
| home-orchestration | jedwards1230 | infra |
| hagen | hagen-ai | service |
| libro-client | jedwards1230 | service |
| mcp-proxy-web | jedwards1230 | service |
| openclaw | jedwards1230 | service |
| openclaw-charts | jedwards1230 | service |
| claude-plugins | jedwards1230 | tooling |
| release-workflows | jedwards1230 | tooling |
| kickstart.nvim | jedwards1230 | tooling |
| lilbro-tf | jedwards1230 | infra |
