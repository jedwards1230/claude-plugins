#!/bin/bash
# Validate OpenTofu config in directories owning files modified on this branch,
# mirroring CI's `tofu init -backend=false && tofu validate`.
#
# Why validate is init-GATED and warn-only on init failure:
#   `tofu validate` requires the working directory to be initialized — without
#   `tofu init` it fails with "Missing required provider" even on perfectly
#   valid config. That is an environment gap, NOT a code defect, so blocking on
#   it would false-fire on every Stop. This hook therefore:
#     1. Runs `tofu init -backend=false -input=false` first when a dir has no
#        .terraform/ (best-effort; providers are cached via TF_PLUGIN_CACHE_DIR
#        so only the first run hits the network).
#     2. If init CANNOT complete (offline, no provider cache, creds needed) it
#        emits a one-line note and SKIPS validate for that dir — never blocks.
#     3. Blocks (exit 2) ONLY on genuine `tofu validate` errors once init has
#        succeeded (or the dir was already initialized).
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
  echo "WARNING: tofu not found in PATH — skipping OpenTofu validate" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Find merge base against default branch.
BASE=""
for candidate in main master; do
  BASE=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
  [ -n "$BASE" ] && break
done

MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

# validate operates on config files (HCL + JSON variants), NOT .tfvars (those
# are inputs, not config). Exclude .terraform/ caches and nested worktrees/.
TF_FILES=$(
  printf '%s\n' "$MODIFIED" \
    | grep -E '\.(tf|tofu)$|\.(tf|tofu)\.json$' \
    | grep -v '/\.terraform/' \
    | grep -v '/worktrees/' | grep -v '^worktrees/' || true
)
[ -z "$TF_FILES" ] && exit 0

# Unique directories that directly contain a modified config file and still
# exist on disk (a file deleted on the branch has no dir to validate).
DIRS=$(
  printf '%s\n' "$TF_FILES" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    d=$(dirname "$f")
    [ "$d" = "" ] && d="."
    [ -d "$d" ] && printf '%s\n' "$d"
  done | sort -u
)
[ -z "$DIRS" ] && exit 0

# Cache providers across runs so repeated inits are fast and offline-friendly.
# Use the sanctioned persistent per-plugin data dir; fall back to the tofu
# default cache location on older hosts.
CACHE_BASE="${CLAUDE_PLUGIN_DATA:-$HOME/.terraform.d}"
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$CACHE_BASE/tofu-plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR" 2>/dev/null || true
# Never prompt; keep tofu non-interactive inside the hook.
export TF_INPUT=0

FAILED=0
while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  slug=$(printf '%s' "$dir" | tr -c 'A-Za-z0-9._-' '-')

  # Initialize (providers + modules, no backend) if not already initialized.
  if [ ! -d "$dir/.terraform" ]; then
    if ! INIT_OUT=$(tofu -chdir="$dir" init -backend=false -input=false -no-color 2>&1); then
      echo "note: tofu validate skipped for $dir — init could not complete (offline, missing provider cache, or backend/creds needed). Run 'tofu -chdir=$dir init' to enable validation." >&2
      continue
    fi
  fi

  if ! VALIDATE_OUT=$(tofu -chdir="$dir" validate -no-color 2>&1); then
    echo "tofu validate failed in: $dir" >&2
    printf '%s\n' "$VALIDATE_OUT" | emit_bounded "validate-$slug.log" "tofu -chdir=$dir validate"
    FAILED=1
  fi
done <<< "$DIRS"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
