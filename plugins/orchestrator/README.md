# orchestrator

Multi-repo PR lifecycle management, milestone orchestration, CI/review monitoring, wave-based parallel implementation, and proactive pipeline management.

## What it does

Provides a structured workflow for coordinating large-scale development across multiple repositories:

- **Wave planning**: Analyze issue dependencies and organize into parallel batches
- **Agent dispatch**: Spawn implementation agents with worktree isolation
- **PR monitoring**: Continuous CI and review status tracking via `/loop`
- **Review response**: Automatically dispatch fix agents for reviewer findings
- **Pipeline advancement**: Start next waves as soon as current work merges

### PR Checking (built-in)

Checks open PRs and reports:

- **CI check status** -- passing, failing, pending, or in-progress
- **Merge conflict detection** -- flags PRs with conflicts
- **Reviewer detection** -- spots pending reviewers, changes requested, and review comments from any source (Copilot, Claude, humans)
- **Unresolved review threads** -- count of open comment threads
- **Bot review warnings** -- detects when CI passes but a reviewer bot flagged issues
- **Recently merged** -- shows PRs merged in the last 24 hours

Uses a single GraphQL query per PR for fast execution.

## Skills

| Skill | When to Use | What It Controls |
|-------|------------|-----------------|
| `agent-loop` | Starting a milestone sprint, managing parallel implementation waves | Full session lifecycle: planning, dispatch, task tracking, wave management, merge ordering |
| `pr-checker` | Monitoring CI status, checking review feedback, one-off PR status checks | PR CI/review monitoring, stale review detection, cross-repo status |

### How they relate

- **`agent-loop`** is the **session controller** -- it runs the whole show autonomously after initial planning. It handles issue analysis, dependency graphs, wave organization, agent dispatch, review response, and pipeline advancement.
- **`pr-checker`** is the **monitoring tool** -- it checks CI status, review threads, and merge readiness for open PRs. It is used by `agent-loop` internally as part of its continuous monitoring loop.
- **You do not need both skills active simultaneously.** When `agent-loop` is running, it invokes `pr-checker` as needed. Use `pr-checker` standalone for quick one-off status checks outside of a full orchestration session.

### Triggers

| Skill | Triggers |
|-------|----------|
| `agent-loop` | "agent-loop", "milestone", "dispatch agents", "wave", "pipeline", "manage PRs", "babysit PRs" |
| `pr-checker` | "check PR", "PR status", "CI status", "prci", "are PRs passing" |

## Hooks

| Hook | Event | Trigger |
|------|-------|---------|
| `git-push-reminder` | PostToolUse (Bash) | Reminds to start a PR monitoring loop after `git push` |

## Dependencies

- `gh` CLI (authenticated)
- `git` (for worktree management)

## Usage

### Orchestration

```
agent-loop the v0.16.0 milestone
implement these 6 issues in parallel
babysit the open PRs until they merge
```

### PR Checking

```
check my PRs
prci
prci 623 624
check PRs in otherorg/service
```

### Direct script

```bash
# All open PRs in current repo (default)
./scripts/prci.sh

# Specific PRs
./scripts/prci.sh 623 624

# All open PRs in another repo
./scripts/prci.sh -R otherorg/service

# Specific PRs in another repo
./scripts/prci.sh -R otherorg/service 623 624
```

## Example output (PR checker)

```
Checking 4 open PRs in myorg/repo-a...

PR #259: ALL PASSING (1 checks) -- HAS MERGE CONFLICTS -- has review comments -- 6 unresolved threads
  REVIEW review comments from claude

PR #253: FAILING (1 failed) -- HAS MERGE CONFLICTS -- has review comments
  FAIL review
  REVIEW review comments from copilot-pull-request-reviewer, claude

PR #235: FAILING (2 failed) -- awaiting review from alice -- has review comments -- 6 unresolved threads
  FAIL review
  FAIL copilot-setup-steps
  REVIEW review comments from copilot-pull-request-reviewer, claude

PR #240: ALL PASSING (3 checks)

Recently merged (last 24h):
  #258 feat: add monitoring dashboard
  #257 fix: handle network timeout on retry
```

## Status reference

| Status | Meaning |
|--------|---------|
| ALL PASSING | All CI checks passed |
| FAILING | One or more checks failed |
| IN PROGRESS | Checks still running or pending |
| UNKNOWN | No check data available |
| MERGED | PR was merged |
| CLOSED | PR was closed without merging |
| HAS MERGE CONFLICTS | Branch conflicts with base |
| awaiting review from X | Reviewer requested but hasn't responded |
| CHANGES REQUESTED | Reviewer formally requested changes |
| has review comments | Reviewer left comments (not blocking) |
| review flagged issues | Bot reviewer found warnings despite CI passing |
| N unresolved threads | Open review comment threads |

## Requirements

- `gh` (GitHub CLI) authenticated
- Repository access for GraphQL queries
