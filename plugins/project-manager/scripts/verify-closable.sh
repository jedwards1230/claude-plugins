#!/usr/bin/env bash
# Find open issues that have merged PRs closing them — candidates for closure.
# Usage: verify-closable.sh [repo-filter...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

mapfile -t repos < <(filter_repos "$@")

echo "## Issues with Merged PRs (candidates for closure)"
echo ""

total=0
for repo in "${repos[@]}"; do
  # Get recently merged PRs (last 30 days)
  prs=$(gh pr list --repo "$repo" --state merged --json number,title,body,mergedAt --limit 50 2>/dev/null || echo "[]")
  pr_count=$(echo "$prs" | jq length)

  if [[ "$pr_count" -eq 0 ]]; then
    continue
  fi

  # Track seen issues to avoid duplicates
  declare -A seen_issues=()
  closable=()

  while IFS= read -r line; do
    pr_num=$(echo "$line" | jq -r '.number')
    pr_title=$(echo "$line" | jq -r '.title')
    pr_body=$(echo "$line" | jq -r '.body // ""')
    merged_at=$(echo "$line" | jq -r '.mergedAt | split("T")[0]')

    # Find issue references in PR body and title (closes #N, fixes #N, resolves #N)
    refs=$(echo "$pr_body $pr_title" | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?) #[0-9]+' | grep -oE '#[0-9]+' | tr -d '#' || true)

    for issue_num in $refs; do
      # Skip duplicates
      key="${repo}#${issue_num}"
      if [[ -n "${seen_issues[$key]+x}" ]]; then
        continue
      fi
      seen_issues["$key"]=1

      # Check if issue is still open
      state=$(gh issue view "$issue_num" --repo "$repo" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
      if [[ "$state" == "OPEN" ]]; then
        closable+=("$repo#$issue_num (PR #$pr_num merged $merged_at)")
        total=$((total + 1))
      fi
    done
  done < <(echo "$prs" | jq -c '.[]')

  if [[ ${#closable[@]} -gt 0 ]]; then
    echo "### $repo"
    for item in "${closable[@]}"; do
      echo "- $item"
    done
    echo ""
  fi

  unset seen_issues
done

if [[ "$total" -eq 0 ]]; then
  echo "No open issues with merged PRs found across ${#repos[@]} repos."
else
  echo "---"
  echo "**Total closable: $total issues across ${#repos[@]} repos**"
  echo ""
  echo "Use project-ops agent to verify and close these issues."
fi
