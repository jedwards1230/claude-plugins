#!/bin/bash
# Block if golangci-lint reports issues on modified Go files.
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
  echo "WARNING: go not found in PATH — skipping lint checks" >&2
  exit 0
fi

# Find golangci-lint: check GOPATH/bin first, then PATH
GOLANGCI=""
GOPATH_DIR=$(go env GOPATH 2>/dev/null || true)
if [ -n "$GOPATH_DIR" ] && [ -x "$GOPATH_DIR/bin/golangci-lint" ]; then
  GOLANGCI="$GOPATH_DIR/bin/golangci-lint"
elif command -v golangci-lint &>/dev/null; then
  GOLANGCI=golangci-lint
else
  echo "WARNING: golangci-lint not found — skipping lint checks" >&2
  echo "Install: https://golangci-lint.run/welcome/install/" >&2
  exit 0
fi

# Build list of packages containing modified Go files
PACKAGES=$(echo "$MODIFIED" | grep '\.go$' | xargs -I{} dirname {} | sort -u | sed 's|^|./|' | tr '\n' ' ')

LINT_OUT=$(mktemp)
trap 'rm -f "$LINT_OUT"' EXIT

# shellcheck disable=SC2086
if $GOLANGCI run --timeout 60s $PACKAGES >"$LINT_OUT" 2>&1; then
  exit 0
fi

# Handle v1/v2 config mismatch gracefully
if grep -q "configuration file for golangci-lint v2 with golangci-lint v1" "$LINT_OUT" 2>/dev/null; then
  echo "WARNING: golangci-lint v1 installed but config requires v2 — skipping" >&2
  exit 0
fi

echo "golangci-lint issues. Fix before finishing:" >&2
cat "$LINT_OUT" >&2
exit 2
