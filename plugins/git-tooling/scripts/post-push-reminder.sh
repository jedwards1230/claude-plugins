#!/usr/bin/env bash
# post-push-reminder.sh - PostToolUse(Bash) hook for git-tooling.
#
# Reads the hook event JSON from stdin. If the tool was a `git push` against
# a branch that has an open PR, emit additionalContext reminding the agent
# to refresh PR title/description if the pushed scope changed.
#
# Stays silent (exit 0, no output) for any Bash call that is not a push, so
# the hook is safe to attach to all Bash invocations.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
[ "$tool_name" = "Bash" ] || exit 0

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.cmd // empty')"
[ -z "$command_str" ] && exit 0

# Only fire for actual `git push` invocations (not `git status` mentioning push, etc.)
case "$command_str" in
  *"git push"*|*"git  push"*) ;;
  *) exit 0 ;;
esac

command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
[ -z "$branch" ] && exit 0

pr_json="$(gh pr list --head "$branch" --state open --json number,title,body,url --limit 1 2>/dev/null || echo '[]')"
pr_count="$(printf '%s' "$pr_json" | jq 'length')"
[ "$pr_count" -eq 0 ] && exit 0

pr_number="$(printf '%s' "$pr_json" | jq -r '.[0].number')"
pr_title="$(printf '%s' "$pr_json" | jq -r '.[0].title')"
pr_url="$(printf '%s' "$pr_json" | jq -r '.[0].url')"

default_base="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||' || echo main)"
recent_commits="$(git log --oneline "origin/${default_base}..${branch}" 2>/dev/null | head -10 || true)"
[ -z "$recent_commits" ] && recent_commits="<none>"

reminder="Just pushed to branch \`${branch}\` which has open PR #${pr_number}: \"${pr_title}\"
${pr_url}

Recent commits on this branch:
${recent_commits}

Reminder: if the pushed scope or intent changed since the PR was opened, update the PR title and description with:
  gh pr edit ${pr_number} --title \"...\" --body \"...\"

Only update if the current title or body no longer accurately describe what is on the branch. Skip silently if they still match."

jq -n --arg ctx "$reminder" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
