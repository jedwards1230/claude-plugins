#!/usr/bin/env bash
# Generate a cross-repo status report of open issues by priority.
# Usage: status-report.sh [--priority P0-critical] [repo-filter...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

priority_filter=""
repo_args=()

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --priority) require_arg "--priority" "$#"; priority_filter="$2"; shift 2 ;;
    *) repo_args+=("$1"); shift ;;
  esac
done

mapfile -t repos < <(filter_repos "${repo_args[@]+"${repo_args[@]}"}")
date_today=$(date +%Y-%m-%d)

echo "## Project Status — $date_today"
echo ""

for priority in "P0-critical" "P1-normal" "P2-low"; do
  if [[ -n "$priority_filter" && "$priority" != "$priority_filter" ]]; then
    continue
  fi

  header_printed=false
  for repo in "${repos[@]}"; do
    issues=$(gh issue list --repo "$repo" --state open --label "$priority" --json number,title,updatedAt,labels --limit 50 2>/dev/null || echo "[]")
    count=$(echo "$issues" | jq length)

    if [[ "$count" -gt 0 ]]; then
      if [[ "$header_printed" == false ]]; then
        echo "### $priority"
        header_printed=true
      fi
      echo "$issues" | jq -r --arg repo "$repo" '.[] | "- \($repo)#\(.number): \(.title) (updated \(.updatedAt | split("T")[0]))"'
    fi
  done
  if [[ "$header_printed" == true ]]; then
    echo ""
  fi
done

# Blocked issues
blocked_printed=false
for repo in "${repos[@]}"; do
  issues=$(gh issue list --repo "$repo" --state open --label "blocked" --json number,title --limit 50 2>/dev/null || echo "[]")
  count=$(echo "$issues" | jq length)
  if [[ "$count" -gt 0 ]]; then
    if [[ "$blocked_printed" == false ]]; then
      echo "### Blocked"
      blocked_printed=true
    fi
    echo "$issues" | jq -r --arg repo "$repo" '.[] | "- \($repo)#\(.number): \(.title)"'
  fi
done
if [[ "$blocked_printed" == true ]]; then echo ""; fi

# Needs-human issues
human_printed=false
for repo in "${repos[@]}"; do
  issues=$(gh issue list --repo "$repo" --state open --label "needs-human" --json number,title --limit 50 2>/dev/null || echo "[]")
  count=$(echo "$issues" | jq length)
  if [[ "$count" -gt 0 ]]; then
    if [[ "$human_printed" == false ]]; then
      echo "### Needs Human Decision"
      human_printed=true
    fi
    echo "$issues" | jq -r --arg repo "$repo" '.[] | "- \($repo)#\(.number): \(.title)"'
  fi
done
if [[ "$human_printed" == true ]]; then echo ""; fi

# Recently closed (last 7 days)
since=$(date -d "7 days ago" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -v-7d +%Y-%m-%dT00:00:00Z 2>/dev/null || echo "")
if [[ -n "$since" ]]; then
  echo "### Recently Completed (last 7 days)"
  for repo in "${repos[@]}"; do
    issues=$(gh issue list --repo "$repo" --state closed --json number,title,closedAt --limit 30 2>/dev/null || echo "[]")
    echo "$issues" | jq -r --arg repo "$repo" --arg since "$since" \
      '.[] | select(.closedAt >= $since) | "- \($repo)#\(.number): \(.title) (closed \(.closedAt | split("T")[0]))"'
  done
  echo ""
fi

# Summary counts
echo "### Summary"
printf "| %-35s | P0 | P1 | P2 | Total |\n" "Repository"
printf "| %-35s | -- | -- | -- | ----- |\n" "---"
for repo in "${repos[@]}"; do
  p0=$(gh issue list --repo "$repo" --state open --label "P0-critical" --json number 2>/dev/null | jq length)
  p1=$(gh issue list --repo "$repo" --state open --label "P1-normal" --json number 2>/dev/null | jq length)
  p2=$(gh issue list --repo "$repo" --state open --label "P2-low" --json number 2>/dev/null | jq length)
  total=$((p0 + p1 + p2))
  printf "| %-35s | %2d | %2d | %2d | %5d |\n" "$repo" "$p0" "$p1" "$p2" "$total"
done
