#!/bin/bash
# prci.sh - Check GitHub PR CI status with detailed feedback
# Usage: prci.sh [-R owner/repo] <pr_num> [pr_num...]
# Requires: gh (GitHub CLI) authenticated

set -euo pipefail

main() {
  local repo_flag=""
  if [ "${1:-}" = "-R" ]; then
    repo_flag="-R $2"
    shift 2
  fi
  # If no PR numbers provided, default to all open PRs
  if [ -z "${1:-}" ]; then
    local pr_nums
    pr_nums=$(gh pr list $repo_flag --state open --json number --jq '.[].number' 2>/dev/null)
    if [ -z "$pr_nums" ]; then
      echo "No open PRs found."
      exit 0
    fi
    # shellcheck disable=SC2086
    set -- $pr_nums
  fi

  # Resolve repo owner/name for GraphQL queries
  local repo_nwo
  if [ -n "$repo_flag" ]; then
    repo_nwo=$(echo "$repo_flag" | awk '{print $2}')
  else
    repo_nwo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
  fi
  local repo_owner="${repo_nwo%%/*}"
  local repo_name="${repo_nwo##*/}"

  local output total passed failed pending running skipped pr_status waiting
  local has_waitci has_review review_missing unresolved_threads
  local review_verdict review_comment review_issues
  for pr in "$@"; do
    # Show merged/closed PRs briefly, then skip detailed checks
    pr_state=$(gh pr view "$pr" $repo_flag --json state -q .state 2>/dev/null || echo "UNKNOWN")
    if [ "$pr_state" = "MERGED" ]; then
      echo "PR #$pr: MERGED"
      echo
      continue
    elif [ "$pr_state" = "CLOSED" ]; then
      echo "PR #$pr: CLOSED"
      echo
      continue
    fi

    output=$(gh pr checks "$pr" $repo_flag 2>/dev/null || true)
    total=$(echo "$output" | wc -l | tr -d ' ')
    passed=$(echo "$output" | grep -c "pass" || true)
    failed=$(echo "$output" | grep -c "fail" || true)
    pending=$(echo "$output" | grep -c "pending" || true)
    running=$(echo "$output" | grep -c "in_progress" || true)
    skipped=$(echo "$output" | grep -c "skipping" || true)

    # Check if review is expected but not yet queued
    review_missing=0
    has_waitci=$(echo "$output" | grep -c "wait-ci" || true)
    has_review=$(echo "$output" | grep -c "review" || true)
    if [ "$has_waitci" -gt 0 ] && [ "$has_review" -eq 0 ]; then
      review_missing=1
      pending=$((pending + 1))
    fi

    # Check for unresolved review threads
    unresolved_threads=0
    if [ -n "$repo_owner" ] && [ -n "$repo_name" ]; then
      unresolved_threads=$(gh api graphql -f query="
        { repository(owner: \"$repo_owner\", name: \"$repo_name\") {
            pullRequest(number: $pr) {
              reviewThreads(first: 100) {
                nodes { isResolved }
        } } } }" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>/dev/null || echo 0)
    fi

    # Check Claude reviewer comment for warnings/issues (CI exits 0 but may flag problems)
    review_verdict=""
    review_issues=""
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

    pr_status=""
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

    # Append review verdict warnings
    if [ "$review_verdict" = "warning" ]; then
      pr_status="$pr_status -- review flagged issues"
    fi

    # Append unresolved thread count to status
    if [ "$unresolved_threads" -gt 0 ]; then
      pr_status="$pr_status -- $unresolved_threads unresolved threads"
    fi

    echo "PR #$pr: $pr_status"
    if [ "$failed" -gt 0 ]; then
      echo "$output" | grep "fail" | awk '{printf "  FAIL %s\n", $1}'
    fi
    if [ "$pending" -gt 0 ] || [ "$running" -gt 0 ]; then
      echo "$output" | grep -E "pending|in_progress" | awk '{printf "  PENDING %s\n", $1}'
    fi
    if [ "$review_missing" -eq 1 ]; then
      echo "  PENDING review (not yet queued)"
    fi
    if [ -n "$review_issues" ]; then
      echo "  WARNING $review_issues"
    fi
    echo
  done
}

main "$@"
