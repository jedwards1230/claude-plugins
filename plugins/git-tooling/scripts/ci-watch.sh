#!/usr/bin/env bash
# ci-watch.sh - Watch GitHub PR CI status, emit one stdout line per state
# transition, exit when every watched PR reaches a terminal state.
#
# Designed to be invoked via the Monitor tool from the ci-watch skill.
# Each stdout line becomes a notification to Claude.
#
# Usage:
#   ci-watch.sh                # watch all open PRs in current repo
#   ci-watch.sh <pr> [pr...]   # watch specific PR numbers
#   ci-watch.sh -R owner/repo  # ...in a specific repo
#
# Env:
#   GIT_TOOLING_CI_POLL_SECONDS  poll interval in seconds (default 30)

set -euo pipefail

POLL_INTERVAL="${GIT_TOOLING_CI_POLL_SECONDS:-30}"

command -v gh >/dev/null 2>&1 || { echo "ci-watch: gh not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ci-watch: jq not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ci-watch: gh not authenticated" >&2; exit 1; }

repo_flag=""
if [ "${1:-}" = "-R" ]; then
  repo_flag="$2"
  shift 2
fi

if [ -n "$repo_flag" ]; then
  repo_nwo="$repo_flag"
else
  repo_nwo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '')"
fi
[ -z "$repo_nwo" ] && { echo "ci-watch: cannot determine GitHub repo" >&2; exit 1; }
owner="${repo_nwo%%/*}"
name="${repo_nwo##*/}"

declare -a pr_nums
if [ $# -gt 0 ]; then
  pr_nums=("$@")
else
  while IFS= read -r n; do
    [ -n "$n" ] && pr_nums+=("$n")
  done < <(gh pr list -R "$repo_nwo" --state open --json number -q '.[].number' 2>/dev/null || true)
fi

if [ ${#pr_nums[@]} -eq 0 ]; then
  echo "ci-watch: no open PRs to watch in $repo_nwo"
  exit 0
fi

echo "ci-watch: watching ${#pr_nums[@]} PR(s) in $repo_nwo (poll every ${POLL_INTERVAL}s)"

# Build a compact status signature for one PR. Emits "<sig>|<active|terminal>".
# Terminal: state is MERGED/CLOSED, OR no checks are pending. Active otherwise.
# Null-safe: defaults statusCheckRollup/contexts to empty arrays so PRs with
# no checks at all do not crash the jq pipeline under `set -e`.
build_signature() {
  local pr="$1" data pr_node state checks
  local passed=0 failed=0 pending=0 mergeable unresolved=0 cr=0 sig

  data="$(gh api graphql -f query="
    { repository(owner: \"$owner\", name: \"$name\") {
        pullRequest(number: $pr) {
          state mergeable
          reviewThreads(first: 50) { nodes { isResolved } }
          latestReviews(first: 10) { nodes { state } }
          commits(last: 1) { nodes { commit { statusCheckRollup {
            contexts(first: 100) {
              nodes {
                ... on CheckRun { name status conclusion }
                ... on StatusContext { context state }
              }
            }
          } } } }
    } } }" 2>/dev/null || echo '{}')"

  pr_node="$(printf '%s' "$data" | jq '.data.repository.pullRequest // empty' 2>/dev/null || echo '')"
  if [ -z "$pr_node" ] || [ "$pr_node" = "null" ]; then
    echo "GONE|terminal"
    return
  fi

  state="$(printf '%s' "$pr_node" | jq -r '.state // "UNKNOWN"')"
  case "$state" in
    MERGED|CLOSED) echo "$state|terminal"; return ;;
  esac

  # Null-safe extraction: missing statusCheckRollup or contexts -> empty array.
  checks="$(printf '%s' "$pr_node" | jq '[(.commits.nodes[0].commit.statusCheckRollup.contexts.nodes // [])[]]' 2>/dev/null || echo '[]')"
  [ -z "$checks" ] && checks='[]'

  passed=$(printf '%s' "$checks" | jq '[.[] | select((.conclusion // "") == "SUCCESS" or (.state // "") == "SUCCESS")] | length' 2>/dev/null || echo 0)
  failed=$(printf '%s' "$checks" | jq '[.[] | select((.conclusion // "") == "FAILURE" or (.conclusion // "") == "TIMED_OUT" or (.state // "") == "FAILURE" or (.state // "") == "ERROR")] | length' 2>/dev/null || echo 0)
  pending=$(printf '%s' "$checks" | jq '[.[] | select((.status // "") == "QUEUED" or (.status // "") == "WAITING" or (.status // "") == "IN_PROGRESS" or (.state // "") == "PENDING")] | length' 2>/dev/null || echo 0)
  mergeable="$(printf '%s' "$pr_node" | jq -r '.mergeable // "UNKNOWN"')"
  unresolved=$(printf '%s' "$pr_node" | jq '[(.reviewThreads.nodes // [])[] | select(.isResolved == false)] | length' 2>/dev/null || echo 0)
  cr=$(printf '%s' "$pr_node" | jq '[(.latestReviews.nodes // [])[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo 0)

  sig="P=${passed},F=${failed},W=${pending}"
  [ "$mergeable" = "CONFLICTING" ] && sig="$sig,CONFLICT"
  [ "$cr" -gt 0 ] && sig="$sig,CR"
  [ "$unresolved" -gt 0 ] && sig="$sig,U=${unresolved}"

  # Terminal when nothing is pending. Failure/success both count.
  if [ "$pending" -eq 0 ]; then
    echo "$sig|terminal"
  else
    echo "$sig|active"
  fi
}

declare -A previous
first_poll=1

while true; do
  all_terminal=1
  for pr in "${pr_nums[@]}"; do
    line="$(build_signature "$pr")"
    sig="${line%|*}"
    status="${line##*|}"
    [ "$status" = "active" ] && all_terminal=0

    prev="${previous[$pr]:-}"
    if [ "$first_poll" -eq 1 ] || [ "$sig" != "$prev" ]; then
      echo "PR #$pr: $sig"
    fi
    previous[$pr]="$sig"
  done
  first_poll=0

  if [ "$all_terminal" -eq 1 ]; then
    echo "ci-watch: all watched PRs reached a terminal state"
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
