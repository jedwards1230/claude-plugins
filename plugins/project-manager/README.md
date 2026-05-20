# project-manager

Project management plugin for multi-repo software ecosystems. Provides standardized triage, sprint planning, status tracking, and cleanup workflows using GitHub Issues and Project boards. The set of tracked repos is supplied by the consuming project via `.claude/rules/plugins/project-manager.yml`.

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
REPO="myorg/repo-a"
gh label create "P0-critical" --repo $REPO --color "b60205" --description "Service down, data loss, security" --force
# ... (see SKILL.md for full script)
```

### 3. Create GitHub Project boards

```bash
gh project create --owner myorg --title "Infra"
gh project create --owner otherorg --title "Service Roadmap"
# ... one per repo
```

### 4. Configure tracked repos

Create `.claude/rules/plugins/project-manager.yml` in the consuming project with the following shape:

```yaml
repos:
  - repo: myorg/repo-a
    scope: infra
    description: Short description
    board: Infra Backlog
  - repo: otherorg/service
    scope: service
    description: Short description
    board: Service Backlog
```

## Usage

```
# Triage new issues
"Triage the new issues in repo-a"

# Sprint planning
"What should I work on next?"

# Status report
"Project status across all repos"

# Cleanup
"Clean up resolved issues in repo-a"

# Stale issue pruning
"Prune stale issues across all repos"
```
