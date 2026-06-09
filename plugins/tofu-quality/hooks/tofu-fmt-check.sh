#!/bin/bash
# Block if modified OpenTofu files are not formatted (diff-based), mirroring the
# common CI check (`tofu fmt -check -recursive`). This gate is pure and
# deterministic — `tofu fmt` needs no provider/backend init — so it hard-blocks
# (exit 2) on any unformatted file.
set -euo pipefail

# Bounded-output helper (emit_bounded). Prefer the plugin-root copy; fall back
# to the script's own dir so the hook works regardless of how it's invoked.
# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/quality-emit.sh" 2>/dev/null \
  || . "$(dirname "$0")/quality-emit.sh"

INPUT=$(cat)

# Prevent infinite loops — guard against missing jq.
if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

if ! command -v tofu &>/dev/null; then
  echo "WARNING: tofu not found in PATH — skipping OpenTofu format check" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Find merge base against default branch.
BASE=""
for candidate in main master; do
  BASE=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
  [ -n "$BASE" ] && break
done

# OpenTofu files modified in working tree, staged, or recent commits on branch.
MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

# fmt covers HCL native syntax: .tf, .tofu, .tfvars (NOT the .json variants).
# Exclude .terraform/ caches and nested worktrees/.
TF_FILES=$(
  printf '%s\n' "$MODIFIED" \
    | grep -E '\.(tf|tofu|tfvars)$' \
    | grep -v '/\.terraform/' \
    | grep -v '/worktrees/' | grep -v '^worktrees/' || true
)
[ -z "$TF_FILES" ] && exit 0

# `tofu fmt -check -list` prints the path of each file that WOULD be reformatted
# and exits non-zero if any do. Pass only existing files (a file deleted on the
# branch is in the diff but not on disk).
EXISTING=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] && EXISTING+=("$f")
done <<< "$TF_FILES"
[ ${#EXISTING[@]} -eq 0 ] && exit 0

UNFORMATTED=$(tofu fmt -check -list=true -no-color "${EXISTING[@]}" 2>/dev/null || true)

if [ -n "$UNFORMATTED" ]; then
  echo "OpenTofu files are not formatted:" >&2
  printf '%s\n' "$UNFORMATTED" | sed 's/^/  /' >&2
  # %q-quote each path so the suggested command is copy-paste safe (spaces etc.).
  printf 'Run: tofu fmt' >&2
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    printf ' %q' "$f" >&2
  done <<< "$UNFORMATTED"
  printf '\n' >&2
  exit 2
fi

exit 0
