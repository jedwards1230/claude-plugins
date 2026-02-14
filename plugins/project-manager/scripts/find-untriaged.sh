#!/usr/bin/env bash
# Find issues missing priority labels across repos.
# Usage: find-untriaged.sh [repo-filter...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

mapfile -t repos < <(filter_repos "$@")

echo "## Untriaged Issues"
echo ""

total=0
for repo in "${repos[@]}"; do
  # Get all open issues with their labels
  issues=$(gh issue list --repo "$repo" --state open --json number,title,labels,createdAt --limit 100 2>/dev/null || echo "[]")

  # Filter to issues missing priority labels
  missing=$(echo "$issues" | jq '[.[] | select(
    ([.labels[]?.name] | any(test("^P[0-2]"))) | not
  )]')
  count=$(echo "$missing" | jq length)

  if [[ "$count" -gt 0 ]]; then
    echo "### $repo ($count untriaged)"
    echo "$missing" | jq -r '.[] | "- #\(.number): \(.title) [labels: \([.labels[]?.name] | join(", "))] (created \(.createdAt | split("T")[0]))"'
    echo ""
    total=$((total + count))
  fi
done

if [[ "$total" -eq 0 ]]; then
  echo "All issues are triaged across ${#repos[@]} repos."
else
  echo "---"
  echo "**Total untriaged: $total issues across ${#repos[@]} repos**"
fi
