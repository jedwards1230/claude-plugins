#!/bin/bash
# Devcontainer entrypoint - runs on every container start.
# Keep this idempotent (safe to run multiple times).

set -euo pipefail

echo "=== Claude Plugins Devcontainer Health Check ==="

# Tool version validation
check_tool() {
  local name="$1"
  local cmd="$2"
  if version=$($cmd 2>/dev/null); then
    printf "  %-18s %s\n" "$name" "$version"
  else
    printf "  %-18s %s\n" "$name" "NOT FOUND"
  fi
}

echo "Tools:"
check_tool "jq" "jq --version"
check_tool "yq" "yq --version"
check_tool "shellcheck" "shellcheck --version"

echo "=== Health Check Complete ==="
