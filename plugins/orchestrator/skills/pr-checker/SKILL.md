---
name: pr-checker
description: "Check GitHub PR CI status, review threads, and reviewer verdicts. Triggers: \"check PR\", \"PR status\", \"CI status\", \"check checks\", \"are PRs passing\", \"prci\", \"check pull requests\"."
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh*)
  - Bash(gh pr checks*)
  - Bash(gh pr view*)
  - Bash(gh api*)
  - Read
example_prompts:
  - "check CI status for PR 123"
  - "are my PRs passing?"
  - "prci"
  - "check PR status for kova-land/kova"
permalink: tooling/claude-plugins/plugins/orchestrator/skills/pr-checker/skill
---

# PR Checker

Check GitHub PR CI status, unresolved review threads, and reviewer verdicts in one command.

## Current Repository (Injected)

**Repository:**
```
!`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "(not in a git repo)"`
```

## Usage

### Check all open PRs in current repo (default)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh
```

### Check specific PRs in current repo

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh <pr_num> [pr_num...]
```

### Check all open PRs in a different repo

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R owner/repo
```

### Check specific PRs in a different repo

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R owner/repo <pr_num> [pr_num...]
```

## Status Reference

| Status | Meaning |
|--------|---------|
| ALL PASSING | All CI checks passed |
| FAILING | One or more CI checks failed |
| IN PROGRESS | Checks are still running or pending |
| UNKNOWN | No check data available |
| MERGED | PR was merged |
| CLOSED | PR was closed without merging |
| HAS MERGE CONFLICTS | Branch conflicts with base |
| review flagged issues | Claude reviewer found warnings (CI passed but review has concerns) |
| N unresolved threads | PR has unresolved review comment threads |

## Features

- **Default: all open PRs** — no args needed, checks every open PR in the current repo
- **Recently merged** — when checking all open PRs, also shows PRs merged in the last 24 hours
- **Merge conflict detection** — flags PRs with conflicts
- **Review thread tracking** — counts unresolved comment threads
- **Reviewer verdict** — detects warnings from Claude reviewer bot comments

## Interpreting Results

1. **FAILING**: Look at the listed failing checks. Use `gh pr checks <num>` for full details, then fix the issues.
2. **IN PROGRESS**: Wait for checks to complete. If `review (not yet queued)` appears, the review job is waiting for other CI to finish.
3. **ALL PASSING**: Safe to merge if no unresolved threads or review warnings.
4. **HAS MERGE CONFLICTS**: Rebase or merge the base branch into the PR branch.
5. **review flagged issues**: Read the reviewer comment on the PR — it may flag missing tests, docs, or code quality concerns that CI cannot catch.
6. **N unresolved threads**: Address each thread before merging. Use `gh api graphql` to list unresolved threads (see code-review rules for the query).

## Workflows

### Quick status of all PRs
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh
```

### Monitor specific PRs (e.g., in a /loop)
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh 623 624 625
```

### Cross-repo check
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/home-orchestration
```

### Parallel multi-repo check
```bash
# Run in parallel for different repos
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R kova-land/kova
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/claude-plugins
```

## Proactive Behavior

When acting as an orchestrator managing multiple PRs:

- **After pushing**: Always start a `/loop 5m /pr-checker` cron to monitor CI status across all repos with open PRs
- **When reviews come in**: Immediately dispatch fix agents to address ALL reviewer findings (code issues, docs gaps, nits) — don't just report them
- **Goal is reviewer all-clear**: Keep iterating fixes until the reviewer gives LGTM with no issues. codecov/patch failures alone are acceptable, but reviewer findings must be addressed
- **Check all repos**: Run the checker against every repo where you have open PRs, not just the current one
- **React to status changes**: When a PR goes from IN PROGRESS to FAILING or ALL PASSING, take appropriate action (fix failures, notify user PRs are ready to merge)
