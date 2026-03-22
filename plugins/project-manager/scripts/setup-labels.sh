#!/usr/bin/env bash
# Create standardized labels across all tracked repos (or specific repos).
# Usage: setup-labels.sh [repo-filter...]
# Example: setup-labels.sh kova home-orchestration
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"
check_gh_auth

mapfile -t repos < <(filter_repos "$@")

create_labels() {
  local repo="$1"
  echo "=== Setting up labels for $repo ==="

  # Priority (3 levels)
  gh label create "P0-critical"  --repo "$repo" --color "b60205" --description "Service down, data loss, security breach" --force
  gh label create "P1-normal"    --repo "$repo" --color "fbca04" --description "Standard work — bugs, features, improvements" --force
  gh label create "P2-low"       --repo "$repo" --color "0e8a16" --description "Nice-to-have, cosmetic, future consideration" --force

  # Type
  gh label create "bug"          --repo "$repo" --color "d73a4a" --description "Something is broken" --force
  gh label create "feature"      --repo "$repo" --color "0075ca" --description "New functionality" --force
  gh label create "chore"        --repo "$repo" --color "cfd3d7" --description "Maintenance, refactoring" --force
  gh label create "epic"         --repo "$repo" --color "5319e7" --description "Large multi-issue initiative" --force
  gh label create "research"     --repo "$repo" --color "c5def5" --description "Investigation, spike, PoC" --force
  gh label create "security"     --repo "$repo" --color "b60205" --description "Vulnerability, hardening, audit" --force
  gh label create "performance"  --repo "$repo" --color "ff7b00" --description "Optimization, latency, resources" --force
  gh label create "dependency"   --repo "$repo" --color "0366d6" --description "Dependency update or migration" --force

  # Scope
  gh label create "infra"        --repo "$repo" --color "1d76db" --description "Infrastructure, K8s, Ansible" --force
  gh label create "service"      --repo "$repo" --color "0e8a16" --description "Application services" --force
  gh label create "tooling"      --repo "$repo" --color "e4e669" --description "Developer tools, CI/CD" --force
  gh label create "docs"         --repo "$repo" --color "0075ca" --description "Documentation only" --force

  # Status
  gh label create "blocked"      --repo "$repo" --color "b60205" --description "Cannot proceed — blocker in description" --force
  gh label create "needs-info"   --repo "$repo" --color "fbca04" --description "Waiting for more information" --force
  gh label create "stale"        --repo "$repo" --color "cfd3d7" --description "No activity for 30+ days" --force

  # Triage gate
  gh label create "needs-triage" --repo "$repo" --color "c2e0c6" --description "Needs agent investigation" --force
  gh label create "needs-human"  --repo "$repo" --color "d93f0b" --description "Requires human decision" --force

  echo ""
}

for repo in "${repos[@]}"; do
  create_labels "$repo" || echo "WARNING: Failed to set up labels for $repo, continuing..."
done

echo "Done. Labels created across ${#repos[@]} repos."
