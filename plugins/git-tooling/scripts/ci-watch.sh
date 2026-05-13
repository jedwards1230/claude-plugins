#!/usr/bin/env bash
# ci-watch.sh - Plugin monitor: poll open-PR CI status and emit one stdout
# line per state transition. Each line becomes a notification to Claude.
#
# Emits at most one line per (PR, transition). Cached state lives in
# $XDG_RUNTIME_DIR (or $TMPDIR) keyed by repo nwo so multiple repos do not
# clobber each other.
#
# Adapted from plugins/orchestrator/scripts/prci.sh — this version is
# stripped to status detection only, no review/comment extraction, so it
# stays fast enough to poll every 60s.

set -euo pipefail

POLL_INTERVAL="${GIT_TOOLING_CI_POLL_SECONDS:-60}"

state_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/git-tooling-ci-watch"
mkdir -p "$state_dir"

# Sanity preflight. If gh or jq missing or unauthenticated, exit quietly so
# the monitor framework does not loop a noisy command.
command -v gh >/dev/null 2>&1 || { echo "ci-watch: gh not found; monitor disabled" >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "ci-watch: jq not found; monitor disabled" >&2; exit 0; }
gh auth status >/dev/null 2>&1 || { echo "ci-watch: gh not authenticated; monitor disabled" >&2; exit 0; }

resolve_repo() {
  gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo ""
}

# Build a compact status digest for one PR.
# Output format on one line: <pr>:<status_signature>
# Where status_signature is e.g. PASS|FAIL=2|PEND=1|CONFLICT|CR
build_signature() {
  local pr="$1" owner="$2" name="$3"
  local data
  data=$(gh api graphql -f query="
    { repository(owner: \"$owner\", name: \"$name\") {
        pullRequest(number: $pr) {
          state
          mergeable
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
    } } }" 2>/dev/null || echo '{}')

  local pr_node state passed failed pending mergeable cr unresolved sig
  pr_node=$(printf '%s' "$data" | jq '.data.repository.pullRequest // empty')
  [ -z "$pr_node" ] || [ "$pr_node" = "null" ] && { echo "$pr:GONE"; return; }

  state=$(printf '%s' "$pr_node" | jq -r '.state')
  case "$state" in
    MERGED|CLOSED) echo "$pr:$state"; return ;;
  esac

  local checks
  checks=$(printf '%s' "$pr_node" | jq '[.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] // empty]')
  passed=$(printf '%s' "$checks" | jq '[.[] | select((.conclusion // "") == "SUCCESS" or (.state // "") == "SUCCESS")] | length')
  failed=$(printf '%s' "$checks" | jq '[.[] | select((.conclusion // "") == "FAILURE" or (.conclusion // "") == "TIMED_OUT" or (.state // "") == "FAILURE" or (.state // "") == "ERROR")] | length')
  pending=$(printf '%s' "$checks" | jq '[.[] | select((.status // "") == "QUEUED" or (.status // "") == "WAITING" or (.status // "") == "IN_PROGRESS" or (.state // "") == "PENDING")] | length')
  mergeable=$(printf '%s' "$pr_node" | jq -r '.mergeable')
  unresolved=$(printf '%s' "$pr_node" | jq '[.reviewThreads.nodes[] | select(.isResolved == false)] | length')
  cr=$(printf '%s' "$pr_node" | jq '[.latestReviews.nodes[] | select(.state == "CHANGES_REQUESTED")] | length')

  sig="P=${passed},F=${failed},W=${pending}"
  [ "$mergeable" = "CONFLICTING" ] && sig="$sig,CONFLICT"
  [ "$cr" -gt 0 ] && sig="$sig,CR"
  [ "$unresolved" -gt 0 ] && sig="$sig,U=${unresolved}"
  echo "$pr:$sig"
}

# Human summary for a signature change.
summarize() {
  local pr="$1" sig="$2"
  case "$sig" in
    MERGED) echo "PR #$pr merged" ;;
    CLOSED) echo "PR #$pr closed" ;;
    GONE)   echo "PR #$pr disappeared from API" ;;
    *)
      # Strip prefix, format compactly
      echo "PR #$pr: $sig"
      ;;
  esac
}

poll_once() {
  local repo="$1"
  [ -z "$repo" ] && return
  local owner name state_file open_prs
  owner="${repo%%/*}"
  name="${repo##*/}"
  state_file="$state_dir/$(printf '%s' "$repo" | tr '/' '_').state"

  open_prs=$(gh pr list -R "$repo" --state open --json number -q '.[].number' 2>/dev/null || true)
  [ -z "$open_prs" ] && return

  declare -A current
  local pr sig line
  while IFS= read -r pr; do
    [ -z "$pr" ] && continue
    line=$(build_signature "$pr" "$owner" "$name")
    sig="${line#*:}"
    current[$pr]="$sig"
  done <<< "$open_prs"

  # Load previous state. First run (no state file) seeds without emitting,
  # so a session that opens with 5 green PRs stays quiet.
  declare -A previous
  local first_run=0
  if [ -f "$state_file" ]; then
    while IFS='=' read -r k v; do
      [ -n "$k" ] && previous[$k]="$v"
    done < "$state_file"
  else
    first_run=1
  fi

  if [ "$first_run" -eq 0 ]; then
    local key prev_sig
    for key in "${!current[@]}"; do
      prev_sig="${previous[$key]:-}"
      if [ -z "$prev_sig" ]; then
        # New PR opened during session — emit so Claude knows about it.
        summarize "$key" "${current[$key]}"
      elif [ "$prev_sig" != "${current[$key]}" ]; then
        summarize "$key" "${current[$key]}"
      fi
    done

    # Detect PRs that disappeared (merged/closed and gh no longer lists them)
    for key in "${!previous[@]}"; do
      if [ -z "${current[$key]:-}" ]; then
        summarize "$key" "GONE"
      fi
    done
  fi

  : > "$state_file"
  for key in "${!current[@]}"; do
    printf '%s=%s\n' "$key" "${current[$key]}" >> "$state_file"
  done
}

main() {
  local repo
  repo="$(resolve_repo)"
  if [ -z "$repo" ]; then
    echo "ci-watch: not in a git repo with a GitHub remote; monitor exiting" >&2
    exit 0
  fi

  echo "ci-watch: monitoring $repo every ${POLL_INTERVAL}s"

  while true; do
    poll_once "$repo" || true
    sleep "$POLL_INTERVAL"
  done
}

main "$@"
