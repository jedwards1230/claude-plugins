# pr-checker

A Claude Code plugin for checking GitHub PR CI status, review threads, and reviewer verdicts.

## Installation

```bash
/plugin install pr-checker
```

## What it does

Checks open PRs and reports:

- **CI check status** -- passing, failing, pending, or in-progress
- **Merge conflict detection** -- flags PRs with conflicts
- **Reviewer detection** -- spots pending reviewers, changes requested, and review comments from any source (Copilot, Claude, humans)
- **Unresolved review threads** -- count of open comment threads
- **Bot review warnings** -- detects when CI passes but a reviewer bot flagged issues
- **Recently merged** -- shows PRs merged in the last 24 hours

Uses a single GraphQL query per PR for fast execution.

## Usage

### Via skill (natural language)

- "check my PRs" -- checks all open PRs in current repo
- "prci" -- same
- "prci 623 624" -- check specific PRs
- "check PRs in kova-land/kova" -- cross-repo

### Direct script

```bash
# All open PRs in current repo (default)
./scripts/prci.sh

# Specific PRs
./scripts/prci.sh 623 624

# All open PRs in another repo
./scripts/prci.sh -R kova-land/kova

# Specific PRs in another repo
./scripts/prci.sh -R kova-land/kova 623 624
```

## Example output

```
Checking 4 open PRs in jedwards1230/home-orchestration...

PR #259: ALL PASSING (1 checks) -- HAS MERGE CONFLICTS -- has review comments -- 6 unresolved threads
  REVIEW review comments from claude

PR #253: FAILING (1 failed) -- HAS MERGE CONFLICTS -- has review comments
  FAIL review
  REVIEW review comments from copilot-pull-request-reviewer, claude

PR #235: FAILING (2 failed) -- awaiting review from jedwards1230 -- has review comments -- 6 unresolved threads
  FAIL review
  FAIL copilot-setup-steps
  REVIEW review comments from copilot-pull-request-reviewer, claude

PR #240: ALL PASSING (3 checks)

Recently merged (last 24h):
  #258 feat: add monitoring dashboard
  #257 fix: NFS mount recovery
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
