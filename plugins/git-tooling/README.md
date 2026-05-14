# git-tooling

Git tooling for Claude Code. Worktree workflows, PR-aware push reminders, and on-demand CI status watching — bundled into one plugin so any Claude session that touches git stays well-behaved.

## Features

- **Worktree management** (skill `git-worktree`) — create, inspect, and clean up worktrees for parallel branch development
- **Default-branch commit guard** (hook) — blocks `git commit` when HEAD is on the repo's default branch (discovered dynamically — works with `main`, `master`, `trunk`, etc.), pushing the agent toward a worktree -> branch -> PR workflow
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

### Default-branch commit guard

Two hooks work together to stop accidental commits on the default branch:

- **`SessionStart`** runs `scripts/session-start-default-branch-cache.sh`, which resolves the current repo's default branch (via `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `gh repo view`) and caches it.
- **`PreToolUse(Bash)`** runs `scripts/precommit-default-branch-guard.sh`. If the Bash command is a real `git commit ...` invocation and HEAD matches the cached default branch, the hook returns `permissionDecision: "deny"` with a message telling the agent to create a worktree and branch first.

Cache location: `${CLAUDE_PLUGIN_DATA}/default-branches.json` (or `${CLAUDE_PLUGIN_ROOT}/.cache/` if `CLAUDE_PLUGIN_DATA` is unset). Entries older than 24h are re-resolved; the guard also resolves on-the-fly on cache miss.

Escape hatch — set `GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1` for a single invocation if you really do want to commit on the default branch:

```bash
GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit -m "..."
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
