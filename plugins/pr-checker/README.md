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
- **Unresolved review threads** -- count of open comment threads
- **Reviewer verdicts** -- warnings from automated Claude reviewer comments
- **Recently merged** -- shows PRs merged in the last 24 hours

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
Checking 3 open PRs in kova-land/kova...

PR #623: ALL PASSING (4 checks)

PR #624: FAILING (1 failed, 1 pending)
  FAIL lint

PR #625: IN PROGRESS (3 passed, 1 pending) -- HAS MERGE CONFLICTS
  PENDING review (not yet queued)

Recently merged (last 24h):
  #593 feat: kova init interactive setup wizard
  #594 feat: WebSocket chat handler for admin API
  #592 feat: CLI/stdin platform adapter
```

## Requirements

- `gh` (GitHub CLI) authenticated
- Repository access for GraphQL queries (review threads, reviewer comments)
