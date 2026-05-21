#!/usr/bin/env bash
# post-push-or-pr-reminder.sh - PostToolUse(Bash) hook for git-tooling.
#
# Reads the hook event JSON from stdin and emits additionalContext when:
#   * `git push` ran against a branch that already has an open PR, OR
#   * `gh pr create` ran (look up the freshly-opened PR for the current branch).
#
# Either trigger nudges the agent to refresh the PR title/description if the
# pushed scope changed and to invoke the `ci-watch` skill to monitor CI.
#
# Stays silent (exit 0, no output) for any Bash call that is not one of those
# triggers, so the hook is safe to attach to all Bash invocations.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
[ "$tool_name" = "Bash" ] || exit 0

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.cmd // empty')"
[ -z "$command_str" ] && exit 0

# Classify the command. We fire on two triggers:
#   trigger="push"      -> a real `git push` (need to parse the pushed ref)
#   trigger="pr_create" -> `gh pr create` (look up PR for current branch)
# Anything else: exit silently.
trigger=""
case "$command_str" in
  *"gh pr create"*|*"gh  pr  create"*)
    trigger="pr_create"
    ;;
  *"git push"*|*"git  push"*)
    trigger="push"
    ;;
  *) exit 0 ;;
esac

command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

# Resolve the branch the reminder should target.
branch=""
if [ "$trigger" = "push" ]; then
  # Parse the pushed ref from the command string. `git push` semantics:
  #   git push                        -> current branch
  #   git push -u origin              -> current branch
  #   git push origin                 -> current branch
  #   git push origin HEAD            -> current branch
  #   git push origin <branch>        -> <branch>
  #   git push origin <src>:<dst>     -> <src> (local ref)
  #   git push -f origin foo bar      -> ambiguous (multi-ref); fall back to HEAD
  #
  # Strategy: extract args after "git push", drop flag-like tokens, then:
  #   * 0-1 positional remaining (just maybe a remote) -> HEAD
  #   * exactly 2 positional (remote + 1 ref)          -> parse that ref
  #   * 3+ positional                                  -> ambiguous, use HEAD
  push_args="${command_str#*git push}"
  push_args="${push_args#*git  push}"
  # Cut at command terminators so we do not slurp chained commands.
  push_args="${push_args%%&&*}"
  push_args="${push_args%%||*}"
  push_args="${push_args%%;*}"
  push_args="${push_args%%|*}"

  # shellcheck disable=SC2206
  tokens=( $push_args )
  positional=()
  if [ ${#tokens[@]} -gt 0 ]; then
    for t in "${tokens[@]}"; do
      case "$t" in
        -*) ;;  # flag, skip
        *) positional+=("$t") ;;
      esac
    done
  fi

  target_ref=""
  case "${#positional[@]}" in
    0|1)
      target_ref=""  # HEAD / current branch
      ;;
    2)
      last_idx=$((${#positional[@]} - 1))
      ref_arg="${positional[$last_idx]}"
      if [ "$ref_arg" = "HEAD" ]; then
        target_ref=""
      elif [[ "$ref_arg" == *:* ]]; then
        target_ref="${ref_arg%%:*}"  # use local side
      else
        target_ref="$ref_arg"
      fi
      ;;
    *)
      # 3+ positional args = multi-ref or unusual form; fall back to HEAD.
      target_ref=""
      ;;
  esac

  # Resolve to a branch name. Empty / HEAD / non-symbolic -> read symbolic-ref.
  if [ -z "$target_ref" ] || [ "$target_ref" = "HEAD" ]; then
    branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
  else
    branch="$target_ref"
  fi
else
  # pr_create: the PR was just opened from whatever branch is currently checked out.
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
fi
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

if [ "$trigger" = "pr_create" ]; then
  lead_line="Just opened PR #${pr_number} from branch \`${branch}\`: \"${pr_title}\"
${pr_url}"
else
  lead_line="Just pushed branch \`${branch}\` which has open PR #${pr_number}: \"${pr_title}\"
${pr_url}"
fi

reminder="${lead_line}

Recent commits on this branch:
${recent_commits}

Reminder: if the pushed scope or intent changed since the PR was opened, update the PR title and description with:
  gh pr edit ${pr_number} --title \"...\" --body \"...\"

Only update if the current title or body no longer accurately describe what is on the branch. Skip silently if they still match.

Now invoke the \`ci-watch\` skill to monitor CI until it reaches a terminal state. This runs in the background and notifies on every status transition; no manual polling needed."

jq -n --arg ctx "$reminder" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
