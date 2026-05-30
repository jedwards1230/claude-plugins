#!/bin/bash
# Block if modified Rust files fail cargo test.
#
# Per-crate dispatch: walks up from each modified .rs file to its owning
# Cargo.toml and runs the test suite from that directory. This handles
# monorepos with multiple crates and Cargo workspaces correctly. If a
# workspace root Cargo.toml (one declaring [workspace]) is present at the
# repo root, runs once from the root (the Cargo-native way).
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

# Check for Rust files modified in working tree, staged, or recent commits on branch
MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

RS_FILES=$(printf '%s\n' "$MODIFIED" | grep '\.rs$' || true)
[ -z "$RS_FILES" ] && exit 0

if ! command -v cargo &>/dev/null; then
  echo "WARNING: cargo not found in PATH — skipping test checks" >&2
  exit 0
fi

# Workspace mode: a root Cargo.toml declaring [workspace] means the Cargo-native
# pattern is to run from the root and let Cargo resolve member crates.
if [ -f Cargo.toml ] && grep -q '^\[workspace\]' Cargo.toml 2>/dev/null; then
  CRATES_TO_CHECK="."
else
  # Walk up from each modified .rs file to its owning crate's Cargo.toml.
  # Bash 3.2 compatible: no associative arrays, just sort -u for dedup.
  CRATES_TO_CHECK=$(
    printf '%s\n' "$RS_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      d=$(dirname "$f")
      while :; do
        if [ -f "$d/Cargo.toml" ]; then
          printf '%s\n' "$d"
          break
        fi
        parent=$(dirname "$d")
        if [ "$parent" = "$d" ]; then
          break  # reached filesystem root, no crate
        fi
        d=$parent
      done
    done | sort -u
  )
fi

# Nothing to check (all files orphaned, or no Rust files at all) — exit silently.
# The session-start probe already warned about this case if relevant.
[ -z "$CRATES_TO_CHECK" ] && exit 0

# Run tests in each affected crate; collect ALL failures.
# Use a temp file rather than process substitution / pipe-to-while so the
# FAILED flag survives in the parent shell (bash 3.2 compatible).
CRATE_LIST=$(mktemp)
trap 'rm -f "$CRATE_LIST"' EXIT
printf '%s\n' "$CRATES_TO_CHECK" > "$CRATE_LIST"

FAILED=0
while IFS= read -r crate_dir; do
  [ -z "$crate_dir" ] && continue
  if ! TEST_OUT=$( (cd "$crate_dir" && cargo test --all-targets) 2>&1 ); then
    echo "cargo test failed in crate: $crate_dir" >&2
    echo "$TEST_OUT" >&2
    FAILED=1
  fi
done < "$CRATE_LIST"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
