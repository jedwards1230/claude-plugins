#!/usr/bin/env bash
# Shared repo registry for project-manager scripts.
# Source this file: source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"

# All tracked repos as "owner/repo" pairs
REPOS=(
  "jedwards1230/home-orchestration"
  "hagen-ai/hagen"
  "jedwards1230/libro-client"
  "jedwards1230/mcp-proxy-web"
  "jedwards1230/openclaw"
  "jedwards1230/openclaw-charts"
  "jedwards1230/claude-plugins"
  "jedwards1230/release-workflows"
  "jedwards1230/kickstart.nvim"
  "jedwards1230/lilbro-tf"
)

# Verify gh auth before running any commands
check_gh_auth() {
  if ! gh auth status &>/dev/null; then
    echo "Error: gh is not authenticated. Run 'gh auth login' first." >&2
    exit 1
  fi
}

# Filter repos if arguments provided, otherwise use all.
# Output: one repo per line. Callers should use: mapfile -t repos < <(filter_repos "$@")
filter_repos() {
  if [[ $# -eq 0 ]]; then
    printf '%s\n' "${REPOS[@]}"
    return
  fi
  for arg in "$@"; do
    for repo in "${REPOS[@]}"; do
      if [[ "$repo" == *"$arg"* ]]; then
        printf '%s\n' "$repo"
      fi
    done
  done
}

# Validate that a flag has a following argument.
# Usage: require_arg "--days" "$@"
require_arg() {
  local flag="$1"
  local remaining="$2"
  if [[ "$remaining" -lt 2 ]]; then
    echo "Error: $flag requires a value" >&2
    exit 1
  fi
}
