# git-tooling

Git tooling for Claude Code. Worktree workflows, PR-aware push reminders, and CI status monitoring — bundled into one plugin so any Claude session that touches git stays well-behaved.

## Features

- **Worktree management** (skill) — create, inspect, and clean up worktrees for parallel branch development
- **Push reminder** (hook) — after every `git push`, nudge the agent to update the PR title/description if the pushed scope drifted from the original PR text
- **CI status monitor** (monitor) — streams pass/fail transitions for open PRs in the current repo so Claude reacts to red builds without being asked

## Prerequisites

- `git` (2.15+)
- `gh` (GitHub CLI, authenticated) — for PR-based workflows, push reminder, and CI monitor
- `jq` — used by the CI monitor and push reminder hook
- Claude Code **v2.1.105+** — required for the monitor component (skill and hook work on older versions too)

## Usage

### Worktree skill

The skill activates automatically when discussing worktree operations:

```
> Create worktrees for all open PRs
> Set up a new worktree for feature/auth
> Clean up stale worktrees
> List my worktrees
```

### Push reminder hook

Runs automatically after every `Bash(git push ...)`. If the pushed branch has an open PR, the hook reminds the agent to check whether the PR title/description still match what got pushed.

### CI monitor

Starts automatically at session start. Polls open PRs in the current repo every 60s and emits a notification line whenever a check transitions (pass ↔ fail ↔ pending) or merge state changes. Claude can react inline without you having to ask "are the checks green yet?"

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
