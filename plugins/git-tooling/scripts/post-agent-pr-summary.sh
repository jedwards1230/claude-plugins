#!/usr/bin/env bash
# post-agent-pr-summary.sh - PostToolUse(Agent|Task) hook for git-tooling.
#
# Fires in the PARENT context after a subagent returns. Reads the subagent's
# transcript JSONL directly to deterministically detect:
#   * any `gh pr create` invocations and the PR URLs they returned
#   * any ci-watch invocations (Monitor with ci-watch.py, or Skill ci-watch)
#
# When PR URL(s) are found, emits additionalContext to the parent so the
# parent agent always learns a PR was opened by its subagent — and whether
# the subagent already started ci-watch or not.
#
# Why this exists: the existing post-push-or-pr-reminder.sh fires inside the
# subagent (which is where the Bash call happens), so its additionalContext
# goes to the subagent, not the parent. The parent ends up with no nudge.
# This hook closes that gap by reading the transcript at the Agent/Task
# boundary, where the parent is in control.
#
# Stays silent (exit 0, no output) when:
#   * jq is missing
#   * agent_id can't be extracted from the Agent tool response
#   * the subagent transcript file isn't on disk
#   * no `gh pr create` invocations are found in the transcript
# A misfire must never break the parent's tool flow — the hook is best-effort.

set -uo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

# Only fire for Agent / Task PostToolUse events. (The matcher should already
# restrict this, but defend in depth.)
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty' 2>/dev/null || true)"
case "$tool_name" in
  Agent|Task) ;;
  *) exit 0 ;;
esac

transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
[ -z "$transcript_path" ] && exit 0

# Extract agent_id from the Agent tool's response. The response includes a
# trailing line like `agentId: <hex>` (verified empirically). Newer/older
# Claude Code versions or certain agent types may omit it — exit silently
# in that case rather than guessing.
tool_response="$(printf '%s' "$payload" | jq -r '
  .tool_response // .tool_result // empty
  | if type == "string" then .
    elif type == "object" then (.content // (.[] // "") | tostring)
    elif type == "array" then (map(if type == "object" then (.content // .text // (. | tostring)) else (. | tostring) end) | join("\n"))
    else (. | tostring)
    end
' 2>/dev/null || true)"
[ -z "$tool_response" ] && exit 0

agent_id="$(printf '%s' "$tool_response" | grep -oE 'agentId: [a-f0-9]+' | head -1 | awk '{print $2}')"
[ -z "$agent_id" ] && exit 0

# Compose the subagent transcript path: <session>.jsonl -> <session>/subagents/agent-<id>.jsonl
session_dir="${transcript_path%.jsonl}"
subagent_transcript="${session_dir}/subagents/agent-${agent_id}.jsonl"
[ -f "$subagent_transcript" ] || exit 0

# Extract PR URLs from `gh pr create` invocations. For each Bash tool_use
# whose command contains `gh pr create`, find the matching tool_result
# (by tool_use_id) and pull `https://github.com/.../pull/N` URLs from its
# content. Then sort/dedupe.
pr_create_ids="$(jq -r '
  select(.type == "assistant")
  | .message.content[]?
  | select(.type == "tool_use" and .name == "Bash")
  | select(.input.command // "" | test("gh[[:space:]]+pr[[:space:]]+create"))
  | .id
' "$subagent_transcript" 2>/dev/null || true)"

[ -z "$pr_create_ids" ] && exit 0

# Build the list of PR URLs by looking up each tool_use_id's result.
pr_urls=""
while IFS= read -r tu_id; do
  [ -z "$tu_id" ] && continue
  result_text="$(jq -r --arg id "$tu_id" '
    select(.type == "user")
    | .message.content[]?
    | select(.type == "tool_result" and .tool_use_id == $id)
    | (
        if (.content | type) == "string" then .content
        elif (.content | type) == "array" then
          (.content | map(if type == "object" then (.text // .content // "") else (. | tostring) end) | join("\n"))
        else (.content | tostring)
        end
      )
  ' "$subagent_transcript" 2>/dev/null || true)"
  [ -z "$result_text" ] && continue
  urls_in_result="$(printf '%s' "$result_text" | grep -oE 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+' || true)"
  [ -z "$urls_in_result" ] && continue
  pr_urls="${pr_urls}${urls_in_result}
"
done <<< "$pr_create_ids"

pr_urls="$(printf '%s' "$pr_urls" | grep -v '^$' | sort -u || true)"
[ -z "$pr_urls" ] && exit 0

# Detect ci-watch invocation: only Monitor calls running ci-watch.py count as
# actually starting the background watcher. A Skill: ci-watch tool_use only
# loads the skill's instructions — per the skill's SKILL.md the agent then
# has to invoke Monitor separately to start the watcher. Counting Skill
# alone would falsely report "watching" when the subagent loaded the skill
# but never followed through.
#
# A tool_use alone isn't proof the call actually ran — it may have been
# rejected (permissions) or errored. Mirror the pr_create two-pass pattern:
# collect tool_use IDs, then verify each one's tool_result exists AND is
# not an error.
ci_watch_ids="$(jq -r '
  select(.type == "assistant")
  | .message.content[]?
  | select(.type == "tool_use")
  | select(.name == "Monitor" and ((.input.command // "") | contains("ci-watch.py")))
  | .id
' "$subagent_transcript" 2>/dev/null || true)"

ci_watch_count=0
while IFS= read -r tu_id; do
  [ -z "$tu_id" ] && continue
  ok="$(jq -r --arg id "$tu_id" '
    select(.type == "user")
    | .message.content[]?
    | select(.type == "tool_result" and .tool_use_id == $id)
    | if (.is_error // false) == false then "ok" else empty end
  ' "$subagent_transcript" 2>/dev/null | head -1 || true)"
  [ "$ok" = "ok" ] && ci_watch_count=$((ci_watch_count + 1))
done <<< "$ci_watch_ids"

# Build PR list / URL list strings for the context message.
pr_numbers=""
pr_url_list=""
while IFS= read -r url; do
  [ -z "$url" ] && continue
  num="${url##*/pull/}"
  if [ -z "$pr_numbers" ]; then
    pr_numbers="#${num}"
    pr_url_list="${url}"
  else
    pr_numbers="${pr_numbers}, #${num}"
    pr_url_list="${pr_url_list}, ${url}"
  fi
done <<< "$pr_urls"

if [ "$ci_watch_count" -gt 0 ]; then
  ctx="Subagent opened PR(s) ${pr_numbers} (${pr_url_list}) and started ci-watch — monitoring runs in background, expect notifications on every CI state transition. No action needed unless ci-watch reports failure."
else
  ctx="Subagent opened PR(s) ${pr_numbers} (${pr_url_list}) but did NOT invoke ci-watch. Consider running it yourself to monitor CI until terminal state."
fi

jq -n --arg ctx "$ctx" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
