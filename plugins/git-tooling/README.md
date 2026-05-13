# git-tooling

Git tooling for Claude Code. Worktree workflows, PR-aware push reminders, and on-demand CI status watching — bundled into one plugin so any Claude session that touches git stays well-behaved.

## Features

- **Worktree management** (skill `git-worktree`) — create, inspect, and clean up worktrees for parallel branch development
- **Push reminder** (hook) — after every `git push`, nudge the agent to update the PR title/description if the pushed scope drifted from the original PR text
- **CI status watching** (skill `ci-watch`) — invoke the `Monitor` tool with a bundled poller that streams pass/fail/pending transitions for open PRs and exits when every watched PR reaches a terminal state. Only runs when you ask for it; no always-on background process.

## Prerequisites

- `git` (2.15+)
- `gh` (GitHub CLI, authenticated) — for PR-based workflows, push reminder, and CI watch
- `jq` — used by the CI watch script and push reminder hook

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

Runs automatically after every `Bash(git push ...)`. If the pushed branch has an open PR, the hook reminds the agent to check whether the PR title/description still match what got pushed. Silent for any non-push Bash call. Parses the pushed refspec so reminders fire against the right PR even when you push a non-current branch.

### CI watch skill

Activates on prompts like:

```
> Watch CI for this PR
> Are the checks green yet?
> Tell me when CI passes
> Follow the build for PR #48
```

Internally invokes the `Monitor` tool with `scripts/ci-watch.sh`. The script polls open-PR CI every 30s, emits one notification per state transition, and exits cleanly when every watched PR reaches a terminal state. Use `TaskStop` to cancel early.

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

The plugin ensures `worktrees/` is in `.gitignore` for the workflows that create them.
