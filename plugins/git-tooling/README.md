# git-tooling

Git tooling for Claude Code. Worktree workflows, PR-aware push reminders, and on-demand CI status watching — bundled into one plugin so any Claude session that touches git stays well-behaved.

## Features

- **Worktree management** (skill `git-worktree`) — create, inspect, and clean up worktrees for parallel branch development
- **Default-branch commit prompt** (hook) — routes `git commit` through Claude Code's permission prompt when HEAD is on the repo's default branch (discovered dynamically — works with `main`, `master`, `trunk`, etc.), so the user gets a "pause and consider" moment to switch to a worktree -> branch -> PR workflow
- **Push reminder** (hook) — after every `git push`, nudge the agent to update the PR title/description if the pushed scope drifted from the original PR text
- **Bulk worktree force-remove guard** (hook) — routes a *bulk* `git worktree remove --force` (a loop/pipe/glob/multiple targets) through the permission prompt, so an unscoped force-removal can't silently wipe other sessions' worktrees and their uncommitted work. Single literal-path removals pass untouched.
- **CI status watching** (skill `ci-watch`) — invoke the `Monitor` tool with a bundled poller that streams pass/fail/pending/review/merge transitions for open PRs and exits when every watched PR is merged or closed. Reports a `READY` milestone when a PR is mergeable, then keeps watching until the actual merge. Only runs when you ask for it; no always-on background process.

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

### Default-branch commit prompt

Two hooks work together to catch accidental commits on the default branch:

- **`SessionStart`** runs `scripts/session-start-default-branch-cache.sh`, which resolves the current repo's default branch (via `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `gh repo view`) and caches it.
- **`PreToolUse(Bash)`** runs `scripts/precommit-default-branch-guard.sh`. If the Bash command is a real `git commit ...` invocation and HEAD matches the cached default branch, the hook returns `permissionDecision: "ask"` with an explanatory message — Claude Code then surfaces a permission prompt so the user (or the surrounding permission mode) can decide whether to proceed.

Cache location: `${CLAUDE_PLUGIN_DATA}/default-branches.json` (or `${CLAUDE_PLUGIN_ROOT}/.cache/` if `CLAUDE_PLUGIN_DATA` is unset). Entries older than 24h are re-resolved; the guard also resolves on-the-fly on cache miss.

Bypass — set `GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1` for a single invocation when you already know you want to commit on the default branch and don't want the prompt (release chores, hotfixes, etc.):

```bash
GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit -m "..."
```

> Note: `permissionDecision: "ask"` semantics across all of Claude Code's permission modes (`acceptEdits`, `bypassPermissions`, headless, subagents) aren't fully documented at the time of writing. Expected behavior is that the prompt flows through whatever the surrounding mode would do for an unallowlisted tool call — auto-allow under `bypassPermissions`, real prompt in default interactive mode. If you hit unexpected behavior in a specific mode, open an issue.

### Bulk worktree force-remove guard

**`PreToolUse(Bash)`** runs `scripts/worktree-remove-guard.sh`. It returns `permissionDecision: "ask"` **only** when a Bash command both (1) force-removes worktrees (`--force`/`-f` with `git worktree remove`) **and** (2) targets a bulk/dynamic set — an enumerate-then-remove pipe (`git worktree list | … remove`), a `for`/`while`/`xargs` loop, a glob target (`worktrees/*`), or two-plus `remove` invocations.

The hazard: in a shared checkout (multiple sessions sharing one set of `<repo>/worktrees/*` roots), a bulk `git worktree remove --force` discards uncommitted work and can wipe *other* sessions' worktrees, not just yours. Plain `git worktree remove` (no `--force`) already refuses a dirty/unmerged tree, so the guard nudges you to drop `--force` and let git's own per-target safety do the filtering.

Intentionally narrow — a single literal-path removal (`git worktree remove --force worktrees/foo`, the normal post-merge cleanup) is **not** bulk and passes silently.

Bypass — set `GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE=1` for a deliberate bulk force-remove:

```bash
GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE=1 git worktree list | xargs git worktree remove --force
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

Internally invokes the `Monitor` tool with `scripts/ci-watch.py`. The script polls open-PR status every 30s (60s once all PRs are ready), emits one notification per state transition, and exits when every watched PR is merged or closed. Use `TaskStop` to cancel early.

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
