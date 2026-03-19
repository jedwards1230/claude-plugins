# pr-checker

A Claude Code plugin for checking GitHub PR CI status, review threads, and reviewer verdicts.

## Installation

```bash
/plugin install pr-checker
```

## What it does

Runs `prci.sh` against one or more PR numbers and reports:

- **CI check status** -- passing, failing, pending, or in-progress
- **Unresolved review threads** -- count of open comment threads
- **Reviewer verdicts** -- warnings from automated Claude reviewer comments

## Usage

### Via skill (natural language)

- "check CI status for PR 123"
- "are my PRs passing?"
- "prci 571 572 573"

### Direct script

```bash
# Current repo
./scripts/prci.sh 123

# Cross-repo
./scripts/prci.sh -R kova-land/kova 569 570
```

## Example output

```
PR #573: ALL PASSING (4 checks) -- 2 unresolved threads

PR #574: FAILING (1 failed, 1 pending)
  FAIL lint

PR #575: IN PROGRESS (3 passed, 1 pending)
  PENDING review (not yet queued)
```

## Requirements

- `gh` (GitHub CLI) authenticated
- Repository access for GraphQL queries (review threads, reviewer comments)
