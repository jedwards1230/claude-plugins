#!/bin/bash
# Block if modified Go files fail go vet or go test.
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

GO_CHANGED=$(echo "$MODIFIED" | grep '\.go$' | head -1 || true)
[ -z "$GO_CHANGED" ] && exit 0

if ! command -v go &>/dev/null; then
  echo "WARNING: go not found in PATH — skipping vet and test checks" >&2
  exit 0
fi

if ! VET_RESULT=$(go vet ./... 2>&1); then
  echo "go vet failed. Fix these issues before finishing:" >&2
  echo "$VET_RESULT" >&2
  exit 2
fi

if ! TEST_RESULT=$(go test -timeout 120s -count=1 ./... 2>&1); then
  echo "go test failed. Fix failing tests before finishing:" >&2
  echo "$TEST_RESULT" >&2
  exit 2
fi

exit 0
