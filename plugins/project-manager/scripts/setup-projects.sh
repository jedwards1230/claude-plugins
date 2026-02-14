#!/usr/bin/env bash
# Create GitHub Project boards with standardized fields for each repo.
# Usage: setup-projects.sh [repo-filter...]
# Note: GitHub Projects are per-owner, not per-repo.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

mapfile -t repos < <(filter_repos "$@")

create_project() {
  local repo="$1"
  local owner="${repo%%/*}"
  local title
  title=$(get_board_title "$repo")
  if [[ -z "$title" || "$title" == "null" ]]; then
    title="$(echo "${repo##*/}" | sed 's/-/ /g') Backlog"
  fi

  echo "=== Creating project '$title' for $owner ==="

  # Check if project already exists (safe jq variable passing)
  local existing
  existing=$(gh project list --owner "$owner" --format json 2>/dev/null \
    | jq -r --arg title "$title" '[.projects[] | select(.title == $title) | .number] | first // empty' 2>/dev/null || echo "")

  if [[ -n "$existing" ]]; then
    echo "  Project '$title' already exists (number: $existing), skipping creation."
    local project_number="$existing"
  else
    project_number=$(gh project create --owner "$owner" --title "$title" --format json | jq -r '.number')
    echo "  Created project #$project_number"
  fi

  # Link project to repo
  gh project link "$project_number" --owner "$owner" --repo "$repo" 2>/dev/null \
    || echo "  (already linked or link not needed)"

  # Add custom fields (idempotent — gh will error if field exists)
  echo "  Adding custom fields..."
  gh project field-create "$project_number" --owner "$owner" --name "Priority" --data-type "SINGLE_SELECT" \
    --single-select-options "P0-critical,P1-normal,P2-low" 2>/dev/null \
    || echo "  Priority field already exists"
  gh project field-create "$project_number" --owner "$owner" --name "Type" --data-type "SINGLE_SELECT" \
    --single-select-options "Bug,Feature,Chore,Epic,Research,Security,Performance,Dependency" 2>/dev/null \
    || echo "  Type field already exists"

  echo ""
}

for repo in "${repos[@]}"; do
  create_project "$repo" || echo "WARNING: Failed to set up project for $repo, continuing..."
done

echo "Done. Projects created/verified for ${#repos[@]} repos."
