---
name: project-manager
description: 'Standards and workflows for project management across all homelab repos.
  Defines label taxonomy, triage process, sprint planning, and cross-repo coordination
  using GitHub Issues and Project boards. Triggers: "plan sprint", "triage issues",
  "project status", "what should I work on", "prioritize backlog", "create epic",
  "project overview", "backlog review", "sprint planning", "issue triage", "what''s
  next", "show backlog", "project health".


  <example>

  Context: User asks what to work on

  user: "What should I work on next?"

  assistant: "I''ll use the project-manager skill to review priorities across all repos
  and recommend the highest-impact work."

  <commentary>

  Skill provides the framework for evaluating and recommending work.

  </commentary>

  </example>


  <example>

  Context: Agent needs to triage a new issue

  assistant: "New issue discovered. Loading project-manager skill to apply standard
  triage workflow — assess impact, set priority, label, and add to board."

  <commentary>

  Both project-manager and project-ops agents load this skill for consistent standards.

  </commentary>

  </example>

  '
allowed-tools:
- Bash
- Read
- Glob
- Grep
---

# Project Management Standards

This skill defines how we manage work across the homelab ecosystem. Both the `project-manager` and `project-ops` agents load these standards. You can also invoke this skill directly for ad-hoc project management tasks.

## Helper Scripts

The plugin includes scripts in `${CLAUDE_PLUGIN_ROOT}/scripts/` for common multi-repo operations:

| Script | Purpose |
|--------|---------|
| `setup-labels.sh [repo...]` | Create standardized labels (one-time, or per-repo) |
| `setup-projects.sh [repo...]` | Create project boards with custom fields (one-time) |
| `status-report.sh [--priority P0-critical]` | Aggregate open issues across all repos |
| `find-untriaged.sh [repo...]` | Find issues missing priority/type labels |
| `find-stale.sh [--days 30] [repo...]` | Find issues with no recent activity |
| `verify-closable.sh [repo...]` | Find open issues with merged PRs |

All scripts read the repo list from `.claude/rules/plugins/project-manager.yml` in the project root (via `yq`). If the config is missing, scripts error with setup instructions.

## Repo Registry

The tracked repos, owners, scopes, descriptions, and board names are defined in the project's `.claude/rules/plugins/project-manager.yml` config file. This file is loaded into agent context via `.claude/rules/plugins/project-manager.md` (which @imports the YAML).

**Required project files:**
- `.claude/rules/plugins/project-manager.md` — rules file with @import
- `.claude/rules/plugins/project-manager.yml` — YAML config with repo list

**YAML format:**
```yaml
repos:
  - repo: owner/repo-name
    scope: infra|service|tooling
    description: Short description
    board: GitHub Project Board Title
```

If the repo registry is not in your context, ask the user to create these files.

## Label Taxonomy

Apply these labels consistently across ALL repos. Use `${CLAUDE_PLUGIN_ROOT}/scripts/setup-labels.sh` for initial setup.

### Priority Labels (3 levels)

| Label | Color | Criteria | SLA |
|-------|-------|----------|-----|
| `P0-critical` | `#b60205` | Service down, data loss, security breach | Immediate — drop everything |
| `P1-normal` | `#fbca04` | Standard work — bugs, features, improvements | This sprint |
| `P2-low` | `#0e8a16` | Nice-to-have, cosmetic, future consideration | When convenient |

### Type Labels

| Label | Color | Description |
|-------|-------|-------------|
| `bug` | `#d73a4a` | Something is broken |
| `feature` | `#0075ca` | New functionality |
| `chore` | `#cfd3d7` | Maintenance, refactoring |
| `epic` | `#5319e7` | Large initiative spanning multiple issues |
| `research` | `#c5def5` | Investigation, spike, proof of concept |
| `security` | `#b60205` | Vulnerability, hardening, audit |
| `performance` | `#ff7b00` | Optimization, latency, resource usage |
| `dependency` | `#0366d6` | Dependency update or migration |

### Scope Labels

| Label | Color | Description |
|-------|-------|-------------|
| `infra` | `#1d76db` | Infrastructure, K8s, Ansible, networking |
| `service` | `#0e8a16` | Application services (hagen, libro, etc.) |
| `tooling` | `#e4e669` | Developer tools, CI/CD, plugins |
| `docs` | `#0075ca` | Documentation only |

### Status Labels

| Label | Color | Description |
|-------|-------|-------------|
| `blocked` | `#b60205` | Cannot proceed — blocker in description |
| `needs-info` | `#fbca04` | Waiting for more information |
| `stale` | `#cfd3d7` | No activity for 30+ days |

### Triage Gate Labels

These labels control agent autonomy. They are the FIRST labels applied during triage.

| Label | Color | Description |
|-------|-------|-------------|
| `needs-triage` | `#c2e0c6` | Needs agent investigation — gather context, assess impact, check related issues |
| `needs-human` | `#d93f0b` | Requires human decision — architecture, product direction, tradeoffs |

**Triage pipeline**: New issue → `needs-triage` → agent investigates → either triaged (priority + type applied, `needs-triage` removed) OR escalated to `needs-human`.

**HARD RULE**: Agents MUST NOT make changes, write code, or make architectural decisions on issues labeled `needs-human`. They may only:
- Gather additional context and add it as a comment
- Present options with tradeoffs for the human to choose
- Link related issues for reference

## Issue Standards

### Title Format

```
<type>: <concise description>
```

Examples:
- `bug: MCP proxy returns 502 when grafana-mcp is restarting`
- `feature: Add Velero backup status to homepage dashboard`
- `chore: Update CloudNativePG to v1.28`
- `epic: Improve observability across all services`

### Issue Body Template

```markdown
## Description
<What needs to happen and why>

## Acceptance Criteria
- [ ] <Specific, verifiable outcome>
- [ ] <Another outcome>

## Context
<Links to related issues, docs, or discussions>

## Related
- owner/repo#N (if cross-repo)
```

### Linking Conventions

- **Cross-repo references**: Always use full format `owner/repo#N`
- **Closing via PR**: Use `Closes owner/repo#N` in PR description
- **Epic tracking**: Epic issue lists sub-issues in its body with checkboxes

## Triage Workflow

When triaging issues (new or unlabeled):

### Step 1: Gather Context
```bash
# Find untriaged issues (use helper script for all repos)
${CLAUDE_PLUGIN_ROOT}/scripts/find-untriaged.sh

# Or for a specific repo
gh issue list --repo OWNER/REPO --state open --search "no:label" --json number,title,createdAt

# Check for duplicates
gh issue list --repo OWNER/REPO --state open --search "KEYWORD"
```

### Step 2: Assess Priority

| | High Urgency (time-sensitive) | Low Urgency (can wait) |
|---|---|---|
| **High Impact** (many users, core functionality) | **P0-critical** | **P1-normal** |
| **Low Impact** (few users, edge case) | **P1-normal** | **P2-low** |

### Step 3: Check Triage Gate

Before acting on the issue, determine:
- **Can an agent fully triage this?** → Apply priority + type labels, remove `needs-triage`
- **Does this need a human decision?** → Apply `needs-human`, add comment explaining what decision is needed

### Step 4: Apply Labels
```bash
gh issue edit NUMBER --repo OWNER/REPO --add-label "P1-normal,feature,service"
gh issue edit NUMBER --repo OWNER/REPO --remove-label "needs-triage"
```

### Step 5: Add to Project Board
```bash
gh project item-add BOARD_NUMBER --owner OWNER --url "https://github.com/OWNER/REPO/issues/NUMBER"
```

### Step 6: Link Related Issues

If the issue relates to work in other repos, add a "Related" section to the issue body.

## Sprint Planning Workflow

When planning what to work on next:

### Step 1: Review High-Priority Issues
```bash
# Use helper script for cross-repo view
${CLAUDE_PLUGIN_ROOT}/scripts/status-report.sh

# Or check specific priority
gh issue list --repo OWNER/REPO --state open --label "P0-critical"
```

### Step 2: Check Blockers
```bash
gh issue list --repo OWNER/REPO --state open --label "blocked"
```

### Step 3: Check Needs-Human Queue
```bash
# Surface issues waiting for human decisions
gh issue list --repo OWNER/REPO --state open --label "needs-human"
```

### Step 4: Identify Themes

Group related issues into logical work streams:
- **Must do**: P0 issues
- **Should do**: P1 issues, especially those unblocking other work
- **Could do**: P2 improvements

### Step 5: Recommend Sprint

Present 3-5 items as the next focus, considering:
- Priority (P0 first, always)
- Dependencies (unblock others)
- Effort vs. impact
- Variety (avoid burnout from only chores)
- `needs-human` items that are blocking agent work

## Cross-Repo Coordination

### Epic Pattern

For work spanning multiple repos, create an epic issue in the primary repo:

```markdown
## Epic: <Title>

### Sub-Issues
- [ ] jedwards1230/home-orchestration#N — K8s manifests
- [ ] hagen-ai/hagen#N — Agent implementation
- [ ] jedwards1230/mcp-proxy-web#N — UI updates

### Status
In progress — 1/3 complete
```

### Dependency Tracking

When issue A blocks issue B across repos:
1. Add `blocked` label to issue B
2. Add comment to B: "Blocked by owner/repo#N"
3. Add comment to A: "Blocks owner/repo#N"

## Status Reporting

### Quick Status
```bash
# Full cross-repo status report
${CLAUDE_PLUGIN_ROOT}/scripts/status-report.sh

# Stale issues
${CLAUDE_PLUGIN_ROOT}/scripts/find-stale.sh --days 30

# Issues ready to close
${CLAUDE_PLUGIN_ROOT}/scripts/verify-closable.sh
```

### Report Format

```
## Project Status — YYYY-MM-DD

### Critical (P0)
- OWNER/REPO#N: <title> — <status note>

### Normal Priority (P1)
- OWNER/REPO#N: <title> — <status note>

### Needs Human Decision
- OWNER/REPO#N: <title> — <what decision is needed>

### Recently Completed
- OWNER/REPO#N: <title> — closed YYYY-MM-DD

### Blockers
- OWNER/REPO#N blocked by OWNER/REPO#M

### Stale Issues (30+ days)
- OWNER/REPO#N: <title> — last activity YYYY-MM-DD

### Recommendations
1. <Highest priority action>
2. <Second priority>
3. <Third priority>
```
