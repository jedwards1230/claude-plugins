#!/usr/bin/env bash
# Shared repo registry for project-manager scripts.
# Reads repos from project YAML config: .claude/rules/plugins/project-manager.yml
# Source this file: source "$(dirname "${BASH_SOURCE[0]}")/repos.sh"

CONFIG_REL_PATH=".claude/rules/plugins/project-manager.yml"

# Find the YAML config by walking up to the git root
find_config() {
  local git_root
  git_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

  if [[ -z "$git_root" ]]; then
    echo "Error: Not in a git repository. Cannot locate project-manager config." >&2
    echo "Run this from within a project that has the project-manager plugin configured." >&2
    exit 1
  fi

  local config_path="$git_root/$CONFIG_REL_PATH"
  if [[ ! -f "$config_path" ]]; then
    echo "Error: Project manager config not found at: $config_path" >&2
    echo "" >&2
    echo "Create the config file with format:" >&2
    echo "  repos:" >&2
    echo "    - repo: owner/repo-name" >&2
    echo "      scope: infra|service|tooling" >&2
    echo "      description: Short description" >&2
    echo "      board: GitHub Project Board Title" >&2
    exit 1
  fi

  echo "$config_path"
}

CONFIG_PATH=$(find_config)

# Load all repos from YAML config
load_repos() {
  yq -r '.repos[].repo' "$CONFIG_PATH"
}

# Get board title for a specific repo
get_board_title() {
  local repo="$1"
  yq -r --arg repo "$repo" '.repos[] | select(.repo == $repo) | .board' "$CONFIG_PATH"
}

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
  local all_repos
  mapfile -t all_repos < <(load_repos)

  if [[ $# -eq 0 ]]; then
    printf '%s\n' "${all_repos[@]}"
    return
  fi

  # Deduplicate matches across args so each repo prints at most once
  declare -A seen
  local arg repo
  for arg in "$@"; do
    for repo in "${all_repos[@]}"; do
      if [[ "$repo" == *"$arg"* && -z "${seen[$repo]+_}" ]]; then
        seen["$repo"]=1
        printf '%s\n' "$repo"
      fi
    done
  done
}

# Validate that a flag has a following argument.
# Usage: require_arg "--days" "$#"
require_arg() {
  local flag="$1"
  local remaining="$2"
  if [[ "$remaining" -lt 2 ]]; then
    echo "Error: $flag requires a value" >&2
    exit 1
  fi
}
