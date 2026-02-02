# git-worktree

Git worktree workflow management for Claude Code. Create, manage, and clean up worktrees for efficient parallel branch development.

## Features

- **PR Worktrees** - Create worktrees for all open GitHub pull requests
- **Interactive Create** - Create new branch + worktree combos with validation
- **Cleanup** - Detect and remove stale worktrees (merged/deleted branches)
- **Inspect** - List worktrees with branch status and uncommitted changes

## Prerequisites

- `git` (2.15+ for full worktree support)
- `gh` (GitHub CLI, authenticated) - for PR-based workflows

## Usage

The skill activates automatically when discussing worktree operations:

```
> Create worktrees for all open PRs
> Set up a new worktree for feature/auth
> Clean up stale worktrees
> List my worktrees
```

## Worktree Directory Convention

Worktrees are created under `<repo-root>/worktrees/`:

```
my-repo/
├── worktrees/
│   ├── feature-auth/
│   ├── bugfix-login/
│   └── pr-123/
├── src/
└── ...
```

The plugin ensures `worktrees/` is in `.gitignore`.

## Allowed Commands

This skill restricts Bash access to specific git and gh commands:

| Category | Commands |
|----------|----------|
| **Worktree** | `git worktree add/list/remove/prune/lock/unlock` |
| **Branch** | `git branch`, `git switch`, `git symbolic-ref` |
| **Inspection** | `git status`, `git diff`, `git log`, `git rev-parse` |
| **Remote** | `git fetch`, `git remote` |
| **GitHub** | `gh pr list/view/checkout`, `gh auth status`, `gh repo view` |
| **Filesystem** | `mkdir`, `ls`, `pwd`, `basename`, `wc` |
