# orchestrator

Multi-repo PR lifecycle management, milestone orchestration, wave-based parallel implementation, and proactive pipeline management.

## What it does

Provides a structured workflow for coordinating large-scale development across multiple repositories:

- **Wave planning**: Analyze issue dependencies and organize into parallel batches
- **Agent dispatch**: Spawn implementation agents with worktree isolation
- **PR monitoring**: Continuous CI and review status tracking via `/loop`
- **Review response**: Automatically dispatch fix agents for reviewer findings
- **Pipeline advancement**: Start next waves as soon as current work merges

## When it activates

The skill triggers on keywords like "orchestrate", "milestone", "dispatch agents", "wave", "pipeline", "manage PRs", "babysit PRs".

## Dependencies

- `pr-checker` plugin (for `/pr-checker` in monitoring loops)
- `gh` CLI (authenticated)
- `git` (for worktree management)

## Usage

```
orchestrate the v0.16.0 milestone
implement these 6 issues in parallel
babysit the open PRs until they merge
```
