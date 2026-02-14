#!/usr/bin/env bash
# Find issues with no activity in N days across repos.
# Usage: find-stale.sh [--days 30] [repo-filter...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

days=30
repo_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      require_arg "--days" "$#"
      days="$2"; shift 2
      if ! [[ "$days" =~ ^[0-9]+$ ]]; then
        echo "Error: --days must be a positive integer, got '$days'" >&2
        exit 1
      fi
      ;;
    *) repo_args+=("$1"); shift ;;
  esac
done

mapfile -t repos < <(filter_repos "${repo_args[@]+"${repo_args[@]}"}")

# Calculate cutoff date
cutoff=$(date -d "$days days ago" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -v-"${days}d" +%Y-%m-%dT00:00:00Z 2>/dev/null || echo "")
if [[ -z "$cutoff" ]]; then
  echo "Error: Failed to calculate cutoff date." >&2
  exit 1
fi

echo "## Stale Issues (no activity in ${days}+ days)"
echo "Cutoff: $cutoff"
echo ""

total=0
for repo in "${repos[@]}"; do
  issues=$(gh issue list --repo "$repo" --state open --json number,title,updatedAt,labels --limit 200 2>/dev/null || echo "[]")

  stale=$(echo "$issues" | jq --arg cutoff "$cutoff" '[.[] | select(.updatedAt < $cutoff)]')
  count=$(echo "$stale" | jq length)

  if [[ "$count" -gt 0 ]]; then
    echo "### $repo ($count stale)"
    echo "$stale" | jq -r '.[] | "- #\(.number): \(.title) (last activity \(.updatedAt | split("T")[0])) [labels: \([.labels[]?.name] | join(", "))]"'
    echo ""
    total=$((total + count))
  fi
done

if [[ "$total" -eq 0 ]]; then
  echo "No stale issues found across ${#repos[@]} repos."
else
  echo "---"
  echo "**Total stale: $total issues across ${#repos[@]} repos**"
fi
