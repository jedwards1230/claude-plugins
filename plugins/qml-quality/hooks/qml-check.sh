#!/bin/bash
# Block if modified QML files are not formatted (diff-based), mirroring the
# game-shell CI check (`qmlformat -i` + fail if diff). qmllint runs warn-only.
#
# Design note — qmlformat parser regression:
#   Local Homebrew qmlformat (6.11.x) fails to parse some valid QML files that
#   CI's Qt 6.8.3 handles fine (confirmed on game-shell's HomeScreen.qml; qmllint
#   parses it cleanly). So a non-zero qmlformat exit is NOT treated as a
#   violation here — the file is skipped with a note. We only block when a file
#   parses cleanly AND its formatted output differs from what's on disk.
set -euo pipefail

INPUT=$(cat)

# Prevent infinite loops — guard against missing jq.
if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

if ! command -v qmlformat &>/dev/null; then
  echo "WARNING: qmlformat not found — skipping QML format check" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Find merge base against default branch.
BASE=""
for candidate in main master; do
  BASE=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
  [ -n "$BASE" ] && break
done

# QML files modified in working tree, staged, or recent commits on this branch.
MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

# Mirror CI path exclusions (worktrees/, .git/).
QML_FILES=$(printf '%s\n' "$MODIFIED" | grep '\.qml$' | grep -v '/worktrees/' | grep -v '^worktrees/' || true)
[ -z "$QML_FILES" ] && exit 0

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

UNFORMATTED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # Parse error (e.g. local qmlformat 6.11 regression) -> skip, do not block.
  if ! qmlformat "$f" >"$TMP" 2>/dev/null; then
    echo "note: qmlformat could not parse $f — skipping (likely local Qt 6.11 parser regression; CI uses 6.8.3)" >&2
    continue
  fi
  if ! diff -q "$TMP" "$f" >/dev/null 2>&1; then
    UNFORMATTED="$UNFORMATTED $f"
  fi
done <<< "$QML_FILES"

# qmllint: warn-only (non-blocking). Import warnings are expected off-target
# (e.g. Quickshell not installed), so this never sets the failure flag.
if command -v qmllint &>/dev/null; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    qmllint "$f" >&2 2>&1 || true
  done <<< "$QML_FILES"
fi

if [ -n "$UNFORMATTED" ]; then
  echo "QML files are not formatted:$UNFORMATTED" >&2
  echo "Run: qmlformat -i$UNFORMATTED" >&2
  exit 2
fi

exit 0
