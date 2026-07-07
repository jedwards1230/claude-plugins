#!/bin/bash
# Block if modified QML files are not formatted (diff-based), mirroring a
# typical QML CI check (`qmlformat -i` + fail if diff). qmllint runs warn-only.
#
# Design note — qmlformat parser regression:
#   Local Homebrew qmlformat (6.11.x) fails to parse some valid QML files that
#   CI's Qt 6.8.3 handles fine (observed on real-world QML that qmllint parses
#   cleanly). So a non-zero qmlformat exit is NOT treated as a
#   violation here — the file is skipped with a note. We only block when a file
#   parses cleanly AND its formatted output differs from what's on disk.
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

UNFORMATTED=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # Parse error (e.g. local qmlformat 6.11 regression) -> skip, do not block.
  if ! qmlformat "$f" >"$TMP" 2>/dev/null; then
    echo "note: qmlformat could not parse $f — skipping (likely local Qt 6.11 parser regression; CI uses 6.8.3)" >&2
    continue
  fi
  if ! diff -q "$TMP" "$f" >/dev/null 2>&1; then
    UNFORMATTED+=("$f")
  fi
done <<< "$QML_FILES"

# qmllint: warn-only (non-blocking). Import warnings are expected off-target
# (e.g. Quickshell not installed), so this never sets the failure flag.
#
# Instead of dumping every qmllint line, collect the full raw output to a log,
# then summarize: count actionable warnings vs. off-target noise ([import] /
# [unqualified], expected without Quickshell installed), and emit ONLY the
# actionable warnings (bounded). Layout-positioning warnings ARE actionable.
if command -v qmllint &>/dev/null; then
  QMLLINT_RAW=$(mktemp)
  trap 'rm -f "$TMP" "$QMLLINT_RAW"' EXIT
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    qmllint "$f" >>"$QMLLINT_RAW" 2>&1 || true
  done <<< "$QML_FILES"

  # Write the FULL raw output to the plugin's persistent log dir so the footer
  # can point at it. (emit_bounded only logs the filtered subset it receives,
  # so we stage the complete log ourselves first.)
  QMLLINT_DIR="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
  mkdir -p "$QMLLINT_DIR" 2>/dev/null || true
  QMLLINT_LOG="$QMLLINT_DIR/qmllint.log"
  cp "$QMLLINT_RAW" "$QMLLINT_LOG" 2>/dev/null || true

  # A warning line looks like:  file.qml:12:3: Warning: ... [category]
  # NOTE: grep -c already prints 0 (and exits 1) on no match; in a simple
  # assignment `set -e` does not abort, so do NOT add `|| echo 0` — that would
  # emit "0\n0" and break the integer comparisons below.
  WARN_TOTAL=$(grep -c 'Warning:' "$QMLLINT_RAW" 2>/dev/null) || true
  NOISE=$(grep 'Warning:' "$QMLLINT_RAW" 2>/dev/null | grep -c -E '\[(import|unqualified)\]') || true
  # Actionable = Warning lines NOT tagged [import]/[unqualified].
  ACTIONABLE_LINES=$(grep 'Warning:' "$QMLLINT_RAW" 2>/dev/null | grep -v -E '\[(import|unqualified)\]' || true)
  ACTIONABLE=$(printf '%s' "$ACTIONABLE_LINES" | grep -c 'Warning:') || true

  if [ "${WARN_TOTAL:-0}" -gt 0 ]; then
    echo "qmllint: ${ACTIONABLE} actionable warning(s), ${NOISE} off-target (import/unqualified, expected without Quickshell installed). Full: cat \"${QMLLINT_LOG}\"" >&2
    if [ "${ACTIONABLE:-0}" -gt 0 ]; then
      printf '%s\n' "$ACTIONABLE_LINES" | emit_bounded "qmllint-actionable.log" "qmllint <file.qml>"
    fi
  fi
fi

if [ ${#UNFORMATTED[@]} -gt 0 ]; then
  echo "QML files are not formatted:" >&2
  printf '  %s\n' "${UNFORMATTED[@]}" >&2
  # %q-quote each path so the suggested command is copy-paste safe (spaces etc.).
  printf 'Run: qmlformat -i' >&2
  printf ' %q' "${UNFORMATTED[@]}" >&2
  printf '\n' >&2
  exit 2
fi

exit 0
