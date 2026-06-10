---
name: ci-watch
description: This skill should be used when the user asks to "watch CI", "are
  the checks green yet", "monitor PR checks", "tell me when CI passes", "follow
  the build", "wait for CI", "ping me when checks finish", "is CI passing",
  "watch the PR", "watch until merged", or any request to keep an eye on GitHub
  PR status without manual polling. Invokes the Monitor tool with ci-watch.py to
  stream CI pass/fail/pending, review status, and merge transitions as
  notifications, stopping only when every watched PR is merged or closed.
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
- watch this PR until it merges
permalink: tooling/claude-plugins/plugins/git-tooling/skills/ci-watch/skill
---

# CI Watch

Watch GitHub PR status through to merge without manually polling. This skill invokes the `Monitor` tool with `ci-watch.py`, which emits one notification per state transition and exits only when every watched PR is merged, closed, or gone. CI completion and review status are reported as intermediate milestones — a `READY` flag appears when a PR is mergeable (all checks green, reviews clear, no conflicts) **and** GitHub's own `mergeStateStatus` does not report the merge blocked (so required reviews, ruleset rules, and conversation-resolution gates are caught even when no tracked signal explains them).

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

| Scenario | `timeout_ms` | `persistent` |
|---|---|---|
| CI-only (user said "tell me when CI passes") | `1800000` (30 min) | `false` |
| Watch until merge (**default**) | `3600000` (60 min, max allowed) | `false` |
| Session-length watching ("keep watching") | any | `true` |

Since the watcher now runs until merge (which may take longer than CI alone), default to `3600000`. Set `persistent: true` if the user explicitly asks for indefinite watching or if merge timing is unpredictable. If the Monitor times out before merge, tell the user and offer to re-invoke.

### Step 4 — Act on notifications

Each notification line emitted by the script looks like:

| Line | Meaning |
|---|---|
| `PR #48: P=3,F=0,W=2` | 3 passed, 0 failed, 2 still waiting |
| `PR #48: P=5,F=0,W=0,READY` | All checks green, reviews done, no conflicts — ready to merge |
| `PR #48: P=4,F=1,W=0` | A check failed — surface to user |
| `PR #48: P=2,F=0,W=3,CR` | Changes requested by a reviewer |
| `PR #48: P=2,F=0,W=3,U=4` | 4 unresolved review threads |
| `PR #48: P=5,F=0,W=0,RR=1` | All checks green but 1 requested reviewer (e.g. Copilot) hasn't posted yet — keep watching |
| `PR #48: P=5,F=0,W=0,BLOCKED` | GitHub reports the merge blocked for a reason the counts don't show — a required review/ruleset (Copilot/CODEOWNERS), a required check, or an unresolved/conversation-resolution gate. Investigate before merging |
| `PR #48: P=3,F=0,W=0,CONFLICT` | Merge conflict |
| `PR #48: MERGED` / `CLOSED` / `GONE` | PR finished |
| `ci-watch: all watched PRs reached a terminal state` | Final line, script exits cleanly |

How to react:

- **`READY`** — all checks passed, reviews complete, no conflicts. Tell the user the PR is ready to merge. Ask if they want to merge now. The watcher keeps running — it will report `MERGED` once the merge happens.
- **Any failures** (`F>0`) — surface immediately. For detailed failing-check names, run `gh pr checks <pr> -R <owner/repo>`.
- **`CR` or `U=N`** — point the user at reviewer feedback before merging.
- **`RR=N`** — N reviewers (typically Copilot's auto-review) still owe a verdict. Watcher keeps polling until they post.
- **`BLOCKED`** — GitHub's authoritative merge state is `BLOCKED` but the tracked counts (`F`/`CR`/`U`/`RR`) don't explain why — e.g. a ruleset requiring a Copilot/CODEOWNERS review, a required status check, or a conversation-resolution gate. Run `gh pr view <pr> --json mergeStateStatus,reviewDecision` and inspect the ruleset/branch protection; resolve the gate before merging. The `READY` flag will not appear while the PR is blocked.
- **`CONFLICT`** — offer to rebase against the base branch.
- **`MERGED`** — the PR was merged. Report success. The watcher exits once all watched PRs reach this (or `CLOSED`/`GONE`).
- **`CLOSED`** / **`GONE`** — PR was closed without merging or deleted from the API.

If the user changes their mind mid-watch, call `TaskStop` to cancel early.

## Notes

- The script's stdout is one notification per line. Lines within 200ms are batched into a single notification by the Monitor tool.
- Poll interval defaults to 30s. Override via `GIT_TOOLING_CI_POLL_SECONDS` env var if the user explicitly wants faster/slower polling (rare — respect GitHub rate limits).
- The script is null-safe for PRs with no checks at all (will report `P=0,F=0,W=0,READY`).
- Once all watched PRs reach READY, the poll interval doubles (e.g. 30s → 60s) to reduce API usage while waiting for merge.
- For a one-shot status snapshot without watching, use `gh pr checks <pr>` or `gh pr view <pr> --json statusCheckRollup`.
