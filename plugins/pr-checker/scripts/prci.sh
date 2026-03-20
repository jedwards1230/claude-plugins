#!/bin/bash
# prci.sh - Check GitHub PR CI status with detailed feedback
#
# Usage:
#   prci.sh                          # All open PRs in current repo
#   prci.sh <pr_num> [pr_num...]     # Specific PRs in current repo
#   prci.sh -R owner/repo            # All open PRs in specified repo
#   prci.sh -R owner/repo <pr_num>.. # Specific PRs in specified repo
#
# Requires: gh (GitHub CLI) authenticated

set -euo pipefail

# Check a single PR and print its status
check_pr() {
  local pr="$1" repo_flag="$2" repo_owner="$3" repo_name="$4"

  # Show merged/closed PRs briefly, then skip detailed checks
  local pr_state
  pr_state=$(gh pr view "$pr" $repo_flag --json state -q .state 2>/dev/null || echo "UNKNOWN")
  if [ "$pr_state" = "MERGED" ]; then
    echo "PR #$pr: MERGED"
    echo
    return
  elif [ "$pr_state" = "CLOSED" ]; then
    echo "PR #$pr: CLOSED"
    echo
    return
  fi

  local output total passed failed pending running skipped
  output=$(gh pr checks "$pr" $repo_flag 2>/dev/null || true)
  total=$(echo "$output" | wc -l | tr -d ' ')
  passed=$(echo "$output" | grep -c "pass" || true)
  failed=$(echo "$output" | grep -c "fail" || true)
  pending=$(echo "$output" | grep -c "pending" || true)
  running=$(echo "$output" | grep -c "in_progress" || true)
  skipped=$(echo "$output" | grep -c "skipping" || true)

  # Check if review is expected but not yet queued
  local review_missing=0 has_waitci has_review
  has_waitci=$(echo "$output" | grep -c "wait-ci" || true)
  has_review=$(echo "$output" | grep -c "review" || true)
  if [ "$has_waitci" -gt 0 ] && [ "$has_review" -eq 0 ]; then
    review_missing=1
    pending=$((pending + 1))
  fi

  # Check for unresolved review threads
  local unresolved_threads=0
  if [ -n "$repo_owner" ] && [ -n "$repo_name" ]; then
    unresolved_threads=$(gh api graphql -f query="
      { repository(owner: \"$repo_owner\", name: \"$repo_name\") {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes { isResolved }
      } } } }" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>/dev/null || echo 0)
  fi

  # Check Claude reviewer comment for warnings/issues (CI exits 0 but may flag problems)
  local review_verdict="" review_issues="" review_comment=""
  if [ -n "$repo_owner" ] && [ -n "$repo_name" ]; then
    review_comment=$(gh api "repos/$repo_owner/$repo_name/issues/$pr/comments" \
      --jq '[.[] | select(.user.login == "github-actions[bot]") | select(.body | test("Claude finished|PR Review"))] | last | .body // empty' 2>/dev/null || echo "")
    if [ -n "$review_comment" ]; then
      if echo "$review_comment" | grep -q "⚠️\|issue.*found\|needs.*update\|needs.*change\|Missing.*test\|documentation.*needed"; then
        review_issues=$(echo "$review_comment" | grep -o "\*\*Status\*\*: ⚠️.*" | head -1 | sed 's/\*\*Status\*\*: ⚠️ *//' || true)
        if [ -z "$review_issues" ]; then
          review_issues=$(echo "$review_comment" | grep -o "⚠️[^*]*" | head -1 | sed 's/^⚠️ *//' || true)
        fi
        review_verdict="warning"
      fi
    fi
  fi

  # Check for merge conflicts
  local has_conflicts=""
  local mergeable
  mergeable=$(gh pr view "$pr" $repo_flag --json mergeable -q .mergeable 2>/dev/null || echo "UNKNOWN")
  if [ "$mergeable" = "CONFLICTING" ]; then
    has_conflicts="HAS MERGE CONFLICTS"
  fi

  local pr_status="" waiting
  if [ "$failed" -gt 0 ]; then
    pr_status="FAILING ($failed failed"
    [ "$pending" -gt 0 ] && pr_status="$pr_status, $pending pending"
    pr_status="$pr_status)"
  elif [ "$pending" -gt 0 ] || [ "$running" -gt 0 ]; then
    waiting=$((pending + running))
    pr_status="IN PROGRESS ($passed passed, $waiting pending)"
  elif [ "$passed" -gt 0 ]; then
    pr_status="ALL PASSING ($passed checks)"
  else
    pr_status="UNKNOWN"
  fi

  # Append flags
  [ -n "$has_conflicts" ] && pr_status="$pr_status -- $has_conflicts"
  [ "$review_verdict" = "warning" ] && pr_status="$pr_status -- review flagged issues"
  [ "$unresolved_threads" -gt 0 ] && pr_status="$pr_status -- $unresolved_threads unresolved threads"

  echo "PR #$pr: $pr_status"
  if [ "$failed" -gt 0 ]; then
    echo "$output" | grep "fail" | awk '{printf "  FAIL %s\n", $1}'
  fi
  if [ "$pending" -gt 0 ] || [ "$running" -gt 0 ]; then
    echo "$output" | grep -E "pending|in_progress" | awk '{printf "  PENDING %s\n", $1}'
  fi
  [ "$review_missing" -eq 1 ] && echo "  PENDING review (not yet queued)"
  [ -n "$review_issues" ] && echo "  WARNING $review_issues"
  echo
}

# Show recently merged PRs (last 24 hours)
show_recent_merges() {
  local repo_flag="$1"
  local since
  since=$(date -u -v-24H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "")

  if [ -z "$since" ]; then
    return
  fi

  local merged_json
  merged_json=$(gh pr list $repo_flag --state merged --json number,title,mergedAt --limit 50 2>/dev/null || echo "[]")

  # Filter to last 24h and format
  local filtered
  filtered=$(echo "$merged_json" | jq -r --arg since "$since" '
    [.[] | select(.mergedAt >= $since)] | sort_by(.mergedAt) | reverse |
    if length == 0 then empty
    else
      if length > 30 then
        { total: length, items: .[:30] }
      else
        { total: length, items: . }
      end |
      .total as $total | .items[] |
      "#\(.number) \(.title)"
    end
  ' 2>/dev/null || echo "")

  if [ -z "$filtered" ]; then
    return
  fi

  local total_count
  total_count=$(echo "$merged_json" | jq --arg since "$since" '[.[] | select(.mergedAt >= $since)] | length' 2>/dev/null || echo 0)

  echo "Recently merged (last 24h):"
  echo "$filtered" | while IFS= read -r line; do
    echo "  $line"
  done
  if [ "$total_count" -gt 30 ]; then
    echo "  ... and $((total_count - 30)) more ($total_count total)"
  fi
  echo
}

main() {
  local repo_flag=""
  if [ "${1:-}" = "-R" ]; then
    repo_flag="-R $2"
    shift 2
  fi

  # Resolve repo owner/name for GraphQL queries
  local repo_nwo
  if [ -n "$repo_flag" ]; then
    repo_nwo=$(echo "$repo_flag" | awk '{print $2}')
  else
    repo_nwo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
    if [ -z "$repo_nwo" ]; then
      echo "Error: not in a git repo and no -R flag provided"
      exit 1
    fi
  fi
  local repo_owner="${repo_nwo%%/*}"
  local repo_name="${repo_nwo##*/}"

  # If no PR numbers given, fetch all open PRs
  local pr_nums=("$@")
  if [ ${#pr_nums[@]} -eq 0 ]; then
    local open_prs
    open_prs=$(gh pr list $repo_flag --state open --json number -q '.[].number' 2>/dev/null || echo "")
    if [ -z "$open_prs" ]; then
      echo "No open PRs in $repo_nwo"
      echo
      show_recent_merges "$repo_flag"
      return
    fi
    while IFS= read -r num; do
      pr_nums+=("$num")
    done <<< "$open_prs"
    echo "Checking ${#pr_nums[@]} open PRs in $repo_nwo..."
    echo
  fi

  for pr in "${pr_nums[@]}"; do
    check_pr "$pr" "$repo_flag" "$repo_owner" "$repo_name"
  done

  # Show recent merges when checking all open PRs (no explicit numbers given)
  if [ $# -eq 0 ]; then
    show_recent_merges "$repo_flag"
  fi
}

main "$@"
