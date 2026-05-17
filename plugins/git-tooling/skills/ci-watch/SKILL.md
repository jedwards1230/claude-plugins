---
name: ci-watch
description: This skill should be used when the user asks to "watch CI", "are
  the checks green yet", "monitor PR checks", "tell me when CI passes", "follow
  the build", "wait for CI", "ping me when checks finish", "is CI passing",
  "watch the PR", or any request to keep an eye on GitHub PR CI status without
  manual polling. Invokes the Monitor tool with ci-watch.py to stream pass /
  fail / pending / changes-requested / merge-conflict transitions as
  notifications, stopping when every watched PR reaches a terminal state.
allowed-tools:
- Bash(python3:*)
- Bash(gh repo view:*)
- Bash(gh pr list:*)
- Bash(git symbolic-ref:*)
- Bash(git rev-parse:*)
- Monitor
- TaskStop
example_prompts:
- watch CI for this PR
- are the checks green yet
- tell me when CI passes
- follow the build for PR #48
- watch all open PR checks
- ping me when CI finishes
permalink: tooling/claude-plugins/plugins/git-tooling/skills/ci-watch/skill
---

# CI Watch

Watch GitHub PR CI status without manually polling. This skill invokes the `Monitor` tool with `ci-watch.py`, which emits one notification per state transition and exits when every watched PR is in a terminal state — all checks finished AND no pending review requests, or the PR is merged/closed.

**Requirements:** `python3` (3.8+) and `gh` (authenticated). The script uses only the Python standard library — no `pip` install needed. Works on macOS and Linux without bash-version dependencies (the previous bash implementation needed bash 4+ for associative arrays, which broke on stock macOS bash 3.2).

## Current Repository State (Injected)

**Repository:**
```
!`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "(not in a github repo)"`
```

**Open PRs:**
```
!`gh pr list --state open --json number,title,headRefName -q '.[] | "#\(.number) \(.title) (\(.headRefName))"' 2>/dev/null || echo "(none)"`
```

**Current branch:**
```
!`git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)"`
```

## How to Use

### Step 1 — Determine which PR(s) to watch

| User intent | Resolution |
|---|---|
| Named a PR number ("watch PR #48") | Pass that number |
| Said "watch this" / "this PR" with no number | Resolve via `gh pr list --head "$(git symbolic-ref --short HEAD)" --state open --json number -q '.[].number'`. If no PR exists, tell the user and stop. |
| Said "all PRs" or "every open PR" | Pass no PR-number args (script defaults to all open) |

### Step 2 — Invoke the Monitor tool

```
Monitor(
  description: "CI status for PR #N",          # or "CI status for N open PRs"
  command: "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/ci-watch.py\" <PR#>",
  persistent: false,
  timeout_ms: <see table below>
)
```

**Always invoke via `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ci-watch.py"`** — do not call the script directly. This avoids depending on the executable bit being preserved through installation.

Argument order: `-R owner/repo` must come *before* any PR numbers (e.g. `python3 ci-watch.py -R owner/repo 48 49`).

### Step 3 — Pick `timeout_ms`

The script exits naturally when all watched PRs reach a terminal state, so `timeout_ms` is just a safety cap.

| CI duration | `timeout_ms` |
|---|---|
| Short (< 10 min) | `1200000` (20 min) |
| Standard (10–20 min) | `1800000` (30 min, **default for most cases**) |
| Long (matrix / integration tests) | `3600000` (60 min, max allowed) |

Set `persistent: true` **only** if the user explicitly asks for session-length watching ("just keep watching until I tell you to stop"). Default to `false`.

### Step 4 — Act on notifications

Each notification line emitted by the script looks like:

| Line | Meaning |
|---|---|
| `PR #48: P=3,F=0,W=2` | 3 passed, 0 failed, 2 still waiting |
| `PR #48: P=5,F=0,W=0` | All passing, no pending — terminal |
| `PR #48: P=4,F=1,W=0` | A check failed — surface to user |
| `PR #48: P=2,F=0,W=3,CR` | Changes requested by a reviewer |
| `PR #48: P=2,F=0,W=3,U=4` | 4 unresolved review threads |
| `PR #48: P=5,F=0,W=0,RR=1` | All checks green but 1 requested reviewer (e.g. Copilot) hasn't posted yet — keep watching |
| `PR #48: P=3,F=0,W=0,CONFLICT` | Merge conflict |
| `PR #48: MERGED` / `CLOSED` / `GONE` | PR finished |
| `ci-watch: all watched PRs reached a terminal state` | Final line, script exits cleanly |

How to react:

- **All green and terminal** — tell the user, ask whether to merge or move on.
- **Any failures** (`F>0`) — surface immediately. If detailed failing-check names would help, the `orchestrator` plugin's `prci.sh` gives them.
- **`CR` or `U=N`** — point the user at reviewer feedback before merging.
- **`RR=N`** — N reviewers (typically Copilot's auto-review) still owe a verdict. Watcher will keep polling until they post; terminal only when checks AND review requests are both clear.
- **`CONFLICT`** — offer to rebase against the base branch.
- **`GONE`** — PR was deleted from the API; nothing more to watch.

If the user changes their mind mid-watch, call `TaskStop` to cancel early.

## Notes

- The script's stdout is one notification per line. Lines within 200ms are batched into a single notification by the Monitor tool.
- Poll interval defaults to 30s. Override via `GIT_TOOLING_CI_POLL_SECONDS` env var if the user explicitly wants faster/slower polling (rare — respect GitHub rate limits).
- The script is null-safe for PRs with no checks at all (will report `P=0,F=0,W=0` as terminal).
- For a one-shot status snapshot without watching, use the `orchestrator` plugin's `prci.sh` instead.
