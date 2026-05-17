#!/bin/bash
# Block if golangci-lint reports issues on modified Go files.
#
# Per-module dispatch: walks up from each modified .go file to its owning
# go.mod and runs golangci-lint from that directory. This handles monorepos
# with multiple modules and Go workspaces correctly. If go.work is present
# at the repo root, runs once from the root.
#
# Within each module we run `./...` rather than narrowing to specific
# packages — intentional for simplicity. Could be tightened if lint perf
# becomes an issue.
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

# Workspace mode: go.work at root means run once from the root.
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

# Nothing to check (all files orphaned) — exit silently.
[ -z "$MODULES_TO_CHECK" ] && exit 0

# Run lint in each affected module; collect ALL failures.
# Temp file pattern (not pipeline-to-while) so FAILED survives in parent shell.
MOD_LIST=$(mktemp)
LINT_OUT=$(mktemp)
trap 'rm -f "$MOD_LIST" "$LINT_OUT"' EXIT
printf '%s\n' "$MODULES_TO_CHECK" > "$MOD_LIST"

FAILED=0
while IFS= read -r module_dir; do
  [ -z "$module_dir" ] && continue
  if (cd "$module_dir" && "$GOLANGCI" run --timeout 60s ./...) >"$LINT_OUT" 2>&1; then
    continue
  fi
  # Handle v1/v2 config mismatch gracefully — skip without failing.
  if grep -q "configuration file for golangci-lint v2 with golangci-lint v1" "$LINT_OUT" 2>/dev/null; then
    echo "WARNING: golangci-lint v1 installed but config requires v2 — skipping module: $module_dir" >&2
    continue
  fi
  echo "golangci-lint issues in module: $module_dir" >&2
  cat "$LINT_OUT" >&2
  FAILED=1
done < "$MOD_LIST"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
