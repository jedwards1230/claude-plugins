#!/bin/bash
# Block if modified Go files fail go vet or go test.
#
# Per-module dispatch: walks up from each modified .go file to its owning
# go.mod and runs vet/test from that directory. This handles monorepos with
# multiple modules and Go workspaces correctly. If go.work is present at
# the repo root, runs once from the root (the Go-native way).
set -euo pipefail

INPUT=$(cat)

# Prevent infinite loops — guard against missing jq
if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

cd "$(git rev-parse --show-toplevel)"

# Find merge base against default branch
BASE=""
for candidate in main master; do
  BASE=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
  [ -n "$BASE" ] && break
done

# Check for Go files modified in working tree, staged, or recent commits on branch
MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

GO_FILES=$(printf '%s\n' "$MODIFIED" | grep '\.go$' || true)
[ -z "$GO_FILES" ] && exit 0

if ! command -v go &>/dev/null; then
  echo "WARNING: go not found in PATH — skipping vet and test checks" >&2
  exit 0
fi

# Workspace mode: go.work at root means the Go-native pattern is to run
# from the root and let Go resolve modules via the workspace file.
if [ -f go.work ]; then
  MODULES_TO_CHECK="."
else
  # Walk up from each modified .go file to its owning module's go.mod.
  # Bash 3.2 compatible: no associative arrays, just sort -u for dedup.
  MODULES_TO_CHECK=$(
    printf '%s\n' "$GO_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      d=$(dirname "$f")
      while :; do
        if [ -f "$d/go.mod" ]; then
          printf '%s\n' "$d"
          break
        fi
        parent=$(dirname "$d")
        if [ "$parent" = "$d" ]; then
          break  # reached filesystem root, no module
        fi
        d=$parent
      done
    done | sort -u
  )
fi

# Nothing to check (all files orphaned, or no Go files at all) — exit silently.
# The session-start probe already warned about this case if relevant.
[ -z "$MODULES_TO_CHECK" ] && exit 0

# Run vet and test in each affected module; collect ALL failures.
# Use a temp file rather than process substitution / pipe-to-while so the
# FAILED flag survives in the parent shell (bash 3.2 compatible).
MOD_LIST=$(mktemp)
trap 'rm -f "$MOD_LIST"' EXIT
printf '%s\n' "$MODULES_TO_CHECK" > "$MOD_LIST"

FAILED=0
while IFS= read -r module_dir; do
  [ -z "$module_dir" ] && continue
  if ! VET_OUT=$( (cd "$module_dir" && go vet ./...) 2>&1 ); then
    echo "go vet failed in module: $module_dir" >&2
    echo "$VET_OUT" >&2
    FAILED=1
  fi
  if ! TEST_OUT=$( (cd "$module_dir" && go test -timeout 120s -count=1 ./...) 2>&1 ); then
    echo "go test failed in module: $module_dir" >&2
    echo "$TEST_OUT" >&2
    FAILED=1
  fi
done < "$MOD_LIST"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
