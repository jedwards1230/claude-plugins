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
  - "prci 573 574 575"
  - "check PR status for kova-land/kova#569"
permalink: tooling/claude-plugins/plugins/pr-checker/skills/pr-checker/skill
---

# PR Checker

Check GitHub PR CI status, unresolved review threads, and reviewer verdicts in one command.

## Current Repository (Injected)

**Repository:**
```
!`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "(not in a git repo)"`
```

## Usage

### Check PRs in the current repo

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh <pr_num> [pr_num...]
```

### Check PRs in a different repo

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
| review flagged issues | Claude reviewer found warnings (CI passed but review has concerns) |
| N unresolved threads | PR has unresolved review comment threads |

## Interpreting Results

1. **FAILING**: Look at the listed failing checks. Use `gh pr checks <num>` for full details, then fix the issues.
2. **IN PROGRESS**: Wait for checks to complete. If `review (not yet queued)` appears, the review job is waiting for other CI to finish.
3. **ALL PASSING**: Safe to merge if no unresolved threads or review warnings.
4. **review flagged issues**: Read the reviewer comment on the PR — it may flag missing tests, docs, or code quality concerns that CI cannot catch.
5. **N unresolved threads**: Address each thread before merging. Use `gh api graphql` to list unresolved threads (see code-review rules for the query).

## Workflows

### Quick status check
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh 123
```

### Batch check multiple PRs
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh 571 572 573
```

### Cross-repo check
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R kova-land/kova 569 570
```
