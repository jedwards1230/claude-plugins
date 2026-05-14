#!/usr/bin/env bash
# session-start-default-branch-cache.sh - SessionStart hook for git-tooling.
#
# Resolves the current repo's default branch and stores it in a small JSON
# cache keyed by absolute repo root. The cache is consumed by the
# precommit-default-branch-guard hook so the guard's hot path does not need
# to shell out to `git ls-remote` or `gh` on every Bash tool call.
#
# Stays silent (exit 0, no output) on any failure — SessionStart noise would
# leak into the user's UI at every session start.

set -euo pipefail

payload="$(cat || true)"

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

# cwd may be missing from payload depending on event source; fall back to PWD.
cwd=""
if [ -n "$payload" ]; then
  cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
fi
[ -z "$cwd" ] && cwd="${PWD:-}"
[ -z "$cwd" ] || [ ! -d "$cwd" ] && exit 0

repo_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$repo_root" ] && exit 0

# Resolve default branch:
#   1. Local origin/HEAD symbolic-ref (fast, no network)
#   2. gh repo view (network, but cached for the rest of the session)
default_branch=""
if ref="$(git -C "$repo_root" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)"; then
  default_branch="${ref#refs/remotes/origin/}"
fi

if [ -z "$default_branch" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # `gh repo view` without `-R` infers the repo from the current directory,
  # which is the hook process's cwd, not necessarily the target repo. Run it
  # from repo_root so the lookup matches the repo we're actually caching for.
  default_branch="$(cd "$repo_root" && gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
fi

[ -z "$default_branch" ] && exit 0

cache_dir="${CLAUDE_PLUGIN_DATA:-${CLAUDE_PLUGIN_ROOT:-$HOME/.cache/claude-git-tooling}/.cache}"
mkdir -p "$cache_dir" 2>/dev/null || exit 0
cache_file="${cache_dir}/default-branches.json"

now="$(date +%s)"

# Merge into existing cache atomically. If the cache file does not exist or is
# unreadable, start fresh.
existing="{}"
if [ -f "$cache_file" ] && [ -r "$cache_file" ]; then
  if parsed="$(jq -c . "$cache_file" 2>/dev/null)"; then
    existing="$parsed"
  fi
fi

updated="$(printf '%s' "$existing" | jq \
  --arg root "$repo_root" \
  --arg branch "$default_branch" \
  --argjson now "$now" \
  '. + {($root): {default_branch: $branch, resolved_at: $now}}')" || exit 0

tmp_file="$(mktemp "${cache_file}.XXXXXX" 2>/dev/null || true)"
[ -z "$tmp_file" ] && exit 0
printf '%s\n' "$updated" > "$tmp_file" && mv -f "$tmp_file" "$cache_file" || rm -f "$tmp_file"

exit 0
