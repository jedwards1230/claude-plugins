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

# Fetch all PR data in a single GraphQL call, then extract fields with jq
check_pr() {
  local pr="$1" repo_owner="$2" repo_name="$3"

  local data
  data=$(gh api graphql -f query="
    { repository(owner: \"$repo_owner\", name: \"$repo_name\") {
        pullRequest(number: $pr) {
          state
          mergeable
          reviewThreads(first: 100) { nodes { isResolved } }
          reviewRequests(first: 10) {
            nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
          }
          latestReviews(first: 10) {
            nodes { author { login } state }
          }
          commits(last: 1) {
            nodes { commit { committedDate statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  ... on CheckRun { name, status, conclusion }
                  ... on StatusContext { context, state }
                }
              }
            } } }
          }
          comments(last: 20) {
            nodes { author { login } body createdAt }
          }
    } } }" 2>/dev/null || echo "{}")

  local pr_node
  pr_node=$(echo "$data" | jq '.data.repository.pullRequest // empty' 2>/dev/null)
  if [ -z "$pr_node" ] || [ "$pr_node" = "null" ]; then
    echo "PR #$pr: NOT FOUND"
    echo
    return
  fi

  # State
  local state
  state=$(echo "$pr_node" | jq -r '.state')
  if [ "$state" = "MERGED" ]; then
    echo "PR #$pr: MERGED"
    echo
    return
  elif [ "$state" = "CLOSED" ]; then
    echo "PR #$pr: CLOSED"
    echo
    return
  fi

  # CI checks from statusCheckRollup
  local checks_json passed=0 failed=0 pending=0 running=0
  local fail_names="" pending_names=""
  checks_json=$(echo "$pr_node" | jq '[.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[] // empty]' 2>/dev/null || echo "[]")

  passed=$(echo "$checks_json" | jq '[.[] | select((.conclusion // "") == "SUCCESS" or (.state // "") == "SUCCESS")] | length' 2>/dev/null || echo 0)
  failed=$(echo "$checks_json" | jq '[.[] | select((.conclusion // "") == "FAILURE" or (.conclusion // "") == "TIMED_OUT" or (.state // "") == "FAILURE" or (.state // "") == "ERROR")] | length' 2>/dev/null || echo 0)
  pending=$(echo "$checks_json" | jq '[.[] | select((.status // "") == "QUEUED" or (.status // "") == "WAITING" or (.state // "") == "PENDING")] | length' 2>/dev/null || echo 0)
  running=$(echo "$checks_json" | jq '[.[] | select((.status // "") == "IN_PROGRESS")] | length' 2>/dev/null || echo 0)

  fail_names=$(echo "$checks_json" | jq -r '[.[] | select((.conclusion // "") == "FAILURE" or (.conclusion // "") == "TIMED_OUT" or (.state // "") == "FAILURE" or (.state // "") == "ERROR") | .name // .context] | .[]' 2>/dev/null || echo "")
  pending_names=$(echo "$checks_json" | jq -r '[.[] | select((.status // "") == "QUEUED" or (.status // "") == "WAITING" or (.status // "") == "IN_PROGRESS" or (.state // "") == "PENDING") | .name // .context] | .[]' 2>/dev/null || echo "")

  # Check if review CI job is expected but not yet queued
  local review_missing=0
  local has_waitci has_review_check
  has_waitci=$(echo "$checks_json" | jq '[.[] | select((.name // .context // "") | test("wait-ci"; "i"))] | length' 2>/dev/null || echo 0)
  has_review_check=$(echo "$checks_json" | jq '[.[] | select((.name // .context // "") | test("review"; "i"))] | length' 2>/dev/null || echo 0)
  if [ "$has_waitci" -gt 0 ] && [ "$has_review_check" -eq 0 ]; then
    review_missing=1
    pending=$((pending + 1))
  fi

  # Merge conflicts
  local has_conflicts=""
  local mergeable
  mergeable=$(echo "$pr_node" | jq -r '.mergeable')
  if [ "$mergeable" = "CONFLICTING" ]; then
    has_conflicts="HAS MERGE CONFLICTS"
  fi

  # Unresolved review threads
  local unresolved_threads
  unresolved_threads=$(echo "$pr_node" | jq '[.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>/dev/null || echo 0)

  # Pending reviewers
  local pending_reviewers
  pending_reviewers=$(echo "$pr_node" | jq -r '[.reviewRequests.nodes[].requestedReviewer | .login // .name // empty] | join(", ")' 2>/dev/null || echo "")

  # Latest review verdicts
  local review_verdict="" review_issues=""
  local changes_requested commented_reviewers
  changes_requested=$(echo "$pr_node" | jq -r '[.latestReviews.nodes[] | select(.state == "CHANGES_REQUESTED") | .author.login] | join(", ")' 2>/dev/null || echo "")
  commented_reviewers=$(echo "$pr_node" | jq -r '[.latestReviews.nodes[] | select(.state == "COMMENTED") | .author.login] | join(", ")' 2>/dev/null || echo "")

  if [ -n "$changes_requested" ]; then
    review_verdict="changes_requested"
    review_issues="changes requested by $changes_requested"
  elif [ -n "$commented_reviewers" ]; then
    review_verdict="commented"
    review_issues="review comments from $commented_reviewers"
  fi

  # Check PR comments for bot reviewer warnings (CI passes but bot flags issues)
  local bot_warning=""
  bot_warning=$(echo "$pr_node" | jq -r '
    [.comments.nodes[] |
      select(.author.login == "github-actions" or .author.login == "copilot-pull-request-reviewer") |
      select(.body | test("⚠️|issue.*found|needs.*update|needs.*change|Missing.*test|documentation.*needed"; "i"))
    ] | last |
    if . then
      (.body | capture("\\*\\*Status\\*\\*: ⚠️ *(?<msg>[^\n]*)") | .msg) // (.body | capture("⚠️ *(?<msg>[^*\n]*)") | .msg) // "issues found"
    else empty end
  ' 2>/dev/null || echo "")
  if [ -n "$bot_warning" ] && [ "$bot_warning" != "null" ]; then
    if [ -z "$review_verdict" ] || [ "$review_verdict" = "commented" ]; then
      review_verdict="warning"
      review_issues="$bot_warning"
    fi
  fi

  # Build status line
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
  [ -n "$pending_reviewers" ] && pr_status="$pr_status -- awaiting review from $pending_reviewers"
  if [ "$review_verdict" = "changes_requested" ]; then
    pr_status="$pr_status -- CHANGES REQUESTED"
  elif [ "$review_verdict" = "warning" ]; then
    pr_status="$pr_status -- review flagged issues"
  elif [ "$review_verdict" = "commented" ]; then
    pr_status="$pr_status -- has review comments"
  fi
  [ "$unresolved_threads" -gt 0 ] && pr_status="$pr_status -- $unresolved_threads unresolved threads"

  # Print
  echo "PR #$pr: $pr_status"
  if [ -n "$fail_names" ]; then
    echo "$fail_names" | while IFS= read -r name; do
      echo "  FAIL $name"
    done
  fi
  if [ -n "$pending_names" ]; then
    echo "$pending_names" | while IFS= read -r name; do
      echo "  PENDING $name"
    done
  fi
  [ "$review_missing" -eq 1 ] && echo "  PENDING review (not yet queued)"
  [ -n "$review_issues" ] && echo "  REVIEW $review_issues"

  # Extract latest Claude reviewer comment (code review + docs sections)
  # Also check if the review is stale (commits pushed after the review)
  local reviewer_comment=""
  reviewer_comment=$(echo "$pr_node" | jq '
    [.comments.nodes[] |
      select(.body | test("Claude Code Reviewer|Claude finished"))
    ] | last // empty' 2>/dev/null || echo "")

  if [ -n "$reviewer_comment" ] && [ "$reviewer_comment" != "null" ]; then
    local review_created_at latest_commit_date is_stale=0
    review_created_at=$(echo "$reviewer_comment" | jq -r '.createdAt // empty' 2>/dev/null || echo "")
    latest_commit_date=$(echo "$pr_node" | jq -r '.commits.nodes[0].commit.committedDate // empty' 2>/dev/null || echo "")

    # Compare timestamps: if latest commit is newer than the review, it's stale
    if [ -n "$review_created_at" ] && [ -n "$latest_commit_date" ]; then
      if [[ "$latest_commit_date" > "$review_created_at" ]]; then
        is_stale=1
      fi
    fi

    local reviewer_body=""
    reviewer_body=$(echo "$reviewer_comment" | jq -r '.body // empty' 2>/dev/null || echo "")

    if [ "$is_stale" -eq 1 ]; then
      # Stale review: show truncated single-line summary
      local first_line=""
      first_line=$(echo "$reviewer_body" | awk '/^### Code Review/{found=1; next} found && /[^ ]/{print; exit}')
      [ -z "$first_line" ] && first_line=$(echo "$reviewer_body" | head -1)
      echo "  REVIEW (stale -- fixes pushed since review): ${first_line:0:120}"
    else
      # Fresh review: show full extracted feedback
      local review_extract=""
      review_extract=$(echo "$reviewer_body" | awk '/^### Code Review/,/^---/' | head -40)
      if [ -n "$review_extract" ]; then
        echo "  ┌─── REVIEWER FEEDBACK ───"
        echo "$review_extract" | while IFS= read -r line; do
          echo "  │ $line"
        done
        echo "  └──────────────────────────"
      fi
    fi
  fi

  echo
}

# Show recently merged PRs (last 24 hours)
show_recent_merges() {
  local repo_flag="$1"
  local since
  since=$(date -u -v-24H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "")
  [ -z "$since" ] && return

  local merged_json
  merged_json=$(gh pr list $repo_flag --state merged --json number,title,mergedAt --limit 50 2>/dev/null || echo "[]")

  local total_count
  total_count=$(echo "$merged_json" | jq --arg since "$since" '[.[] | select(.mergedAt >= $since)] | length' 2>/dev/null || echo 0)
  [ "$total_count" -eq 0 ] && return

  echo "Recently merged (last 24h):"
  echo "$merged_json" | jq -r --arg since "$since" '
    [.[] | select(.mergedAt >= $since)] | sort_by(.mergedAt) | reverse | .[:30][] |
    "  #\(.number) \(.title)"
  ' 2>/dev/null
  [ "$total_count" -gt 30 ] && echo "  ... and $((total_count - 30)) more ($total_count total)"
  echo
}

main() {
  local repo_flag=""
  if [ "${1:-}" = "-R" ]; then
    repo_flag="-R $2"
    shift 2
  fi

  # Resolve repo owner/name
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
    check_pr "$pr" "$repo_owner" "$repo_name"
  done

  # Show recent merges when checking all open PRs (no explicit numbers given)
  if [ $# -eq 0 ]; then
    show_recent_merges "$repo_flag"
  fi
}

main "$@"
