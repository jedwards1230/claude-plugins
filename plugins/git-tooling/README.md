# git-tooling

Git tooling for Claude Code. Worktree workflows, PR-aware push reminders, and on-demand CI + release status watching — bundled into one plugin so any Claude session that touches git stays well-behaved.

## Features

- **Worktree management** (skill `git-worktree`) — create, inspect, and clean up worktrees for parallel branch development
- **Default-branch commit prompt** (hook) — routes `git commit` through Claude Code's permission prompt when HEAD is on the repo's default branch (discovered dynamically — works with `main`, `master`, `trunk`, etc.), so the user gets a "pause and consider" moment to switch to a worktree -> branch -> PR workflow
- **Push reminder** (hook) — after every `git push`, nudge the agent to update the PR title/description if the pushed scope drifted from the original PR text
- **Bulk worktree force-remove guard** (hook) — routes a *bulk* `git worktree remove --force` (a loop/pipe/glob/multiple targets) through the permission prompt, so an unscoped force-removal can't silently wipe other sessions' worktrees and their uncommitted work. Single literal-path removals pass untouched.
- **Force-push guard** (hook) — routes a `git push` through the permission prompt when it uses a *non-lease* force (`--force`/`-f`/`+refspec`) or targets the repo's default/protected branch. Stays silent for the normal feature-branch flow, including pre-approved `--force-with-lease` rebase hygiene on feature branches. Catches the case where a *subagent* is instructed to force-push (settings don't gate subagent Bash; this hook does).
- **Worktree edit-path guard** (hook) — denies an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call when the session is working in a worktree (`<repo>/worktrees/<branch>/`) but the target path is the same repo's MAIN checkout — the "silently edited the wrong copy" mistake. The reverse direction (editing into a worktree from the main checkout) and sibling-worktree edits stay untouched.
- **CI status watching** (skill `ci-watch`) — invoke the `Monitor` tool with a bundled poller that streams pass/fail/pending/review/merge transitions for open PRs and exits when every watched PR is merged or closed. Reports a `READY` milestone when a PR is mergeable, then keeps watching until the actual merge. Only runs when you ask for it; no always-on background process.
- **Release watching** (skill `release-watch`) — the sibling of `ci-watch` that begins where it ends (at `MERGED`). Invoke the `Monitor` tool with a bundled poller that follows a release through to publication: the GitHub release workflow run, the git tag + GitHub Release, **and** GHCR container/chart package publishes (a new image version — or a moving tag like `latest` repointed to a new digest — at `ghcr.io/<owner>/<pkg>`, incl. nested names like `charts/hermes`). Emits on success **and** failure terminals (a failed release workflow is surfaced, never silent). Public GHCR packages read anonymously; private ones need the `gh` token to carry `read:packages` (else that target fails gracefully without crashing the watch).

## Prerequisites

- `git` (2.15+)
- `gh` (GitHub CLI, authenticated) — for PR-based workflows, push reminder, and CI/release watch
- `jq` — used by the push-reminder hook (and other hook scripts)

> The `ci-watch` and `release-watch` scripts use only the Python 3 standard library (no `pip`/Docker/`jq`) and need `python3` (3.8+).

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

### Force-push guard

**`PreToolUse(Bash)`** runs `scripts/force-push-guard.sh`. It returns `permissionDecision: "ask"` when a `git push` crosses a gated boundary, while staying silent for the normal feature-branch flow. It fires when **either**:

1. the push uses a **non-lease force** — `--force`, `-f`, or a `+refspec` (these overwrite the remote unconditionally and can clobber another session's/teammate's commits), **or**
2. the push **targets the default/protected branch** — the cached repo default branch (see the commit-prompt cache above) or a literal `main`/`master`. Covers both direct-to-main pushes and force-pushes to main.

It deliberately does **not** fire on:

- a plain `git push` of a feature branch (the normal PR flow), or
- `--force-with-lease` / `--force-if-includes` to a **non-default** branch — the pre-approved "rebase onto moved main" hygiene on feature branches.

Why a hook rather than a settings rule: `git push` isn't allow-listed, so the gate is behavioral — and the realistic failure mode is a *subagent* being told to force-push as part of a rebase. Settings don't reliably gate subagent Bash calls; a plugin hook fires for them too. The guard reuses the same `default-branches.json` cache as the commit prompt and does no network calls on the hot path.

Bypass — set `GIT_TOOLING_ALLOW_FORCE_PUSH=1` for a deliberate force-push:

```bash
GIT_TOOLING_ALLOW_FORCE_PUSH=1 git push --force origin main
```

### Worktree edit-path guard

**`PreToolUse(Edit|Write|MultiEdit|NotebookEdit)`** runs `scripts/worktree-editpath-guard.sh`. It returns `permissionDecision: "deny"` when the session's `cwd` resolves into a linked git worktree (`<repo>/worktrees/<branch>/`) **and** the edit target is a path under that same repo's root but *outside* any `worktrees/` subtree — i.e. the main checkout. The denial message names the equivalent worktree-prefixed path.

It stays silent for everything else:

- editing *into* a worktree from a main-checkout session (a normal, deliberate pattern),
- editing a file in a **sibling** worktree of the same repo,
- new (not-yet-existing) file targets — still guarded the same way,
- anything outside the repo entirely, and
- nested repos (e.g. `repos/<name>/worktrees/<branch>/`) — scoped independently per repo.

Bails out with pure string checks before touching git for the common cases (no `worktrees/` in `cwd`, or the target isn't under the same repo root), and only shells out to `git rev-parse --git-dir`/`--git-common-dir` to confirm a genuine *linked* worktree before denying — failing open (silent allow) on any ambiguity, so a directory that merely has `worktrees` as a path segment without real worktree state is never falsely blocked.

Bypass — set `GIT_TOOLING_ALLOW_MAIN_CHECKOUT_EDIT=1` in the environment when editing the main checkout from a worktree session is genuinely intended (e.g. post-merge cleanup):

```bash
GIT_TOOLING_ALLOW_MAIN_CHECKOUT_EDIT=1 claude
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

### Release watch skill

Activates on prompts like:

```
> Watch the release for owner/repo
> Did the release publish yet?
> Wait for tag v1.4.0 to publish
> Watch for the new ghcr image
> Did the chart push to ghcr?
```

Internally invokes the `Monitor` tool with `scripts/release-watch.py`. Argument forms mix freely in one call:

```
release-watch.py owner/repo                       # release workflow run + newest release tag
release-watch.py owner/repo --tag v1.4.0          # wait for a specific GitHub Release
release-watch.py --ghcr owner/pkg                 # new GHCR image version vs baseline at start
release-watch.py --ghcr owner/charts/hermes       # nested package name
release-watch.py --ghcr owner/pkg --tag v1.4.0    # wait for a specific image tag
release-watch.py owner/svc --ghcr owner/svc       # both halves of one release in one watcher
```

`--tag T` binds to the immediately preceding target. The script polls every 30s (override via `GIT_TOOLING_RELEASE_POLL_SECONDS`), emits one notification per transition, and exits when every target is published or its release workflow concludes — exit 1 if any target hit a failure terminal (release workflow failed, or a private package the token can't read). Pass `--tag` for an already-published release/version and it reports it and exits at once. Use `TaskStop` to cancel early.

Each notification is one line per transition — good terminals (`RELEASED <tag>`, `PUBLISHED <pkg>:<tag>`, `PUBLISHED <pkg>:latest repointed -> <digest>`), neutral terminals (`RUN success — no new release`, `idle — no release in flight`), and failure terminals (`RUN failure — release workflow failed (<url>)`, `INACCESSIBLE — … needs read:packages`). The full signature/output reference is the table in [`skills/release-watch/SKILL.md`](skills/release-watch/SKILL.md) (its source of truth), the same way `ci-watch`'s lives in its own SKILL.md.

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
