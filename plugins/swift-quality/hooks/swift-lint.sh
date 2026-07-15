#!/bin/bash
# Block if modified Swift files fail SwiftLint.
#
# Opt-in by config: only runs when a .swiftlint.yml is present at the repo
# root. SwiftLint's default rule set on a repo that never adopted it produces
# wall-of-noise violations, so absence of config means the repo hasn't opted
# in and this gate stays silent — mirroring CI, which only lints where a
# config exists.
#
# Diff-scoped: lints only the Swift files modified on the current branch
# (working tree, staged, and commits since the merge-base with main/master).
# SwiftLint exits non-zero on error-severity violations; warnings are shown
# in the output but do not block on their own.
set -euo pipefail

# Homebrew on Apple Silicon installs into /opt/homebrew/bin, which is not on
# PATH in a fresh shell. Each hook runs as its own process, so prepend it here.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# Bounded-output helper (emit_bounded). Prefer the plugin-root copy; fall back
# to the script's own dir so the hook works regardless of how it's invoked.
# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/quality-emit.sh" 2>/dev/null \
  || . "$(dirname "$0")/quality-emit.sh"

INPUT=$(cat)

# Prevent infinite loops — guard against missing jq
if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

cd "$(git rev-parse --show-toplevel)"

# Opt-in gate: no repo-root SwiftLint config → nothing to mirror, exit silently.
[ -f .swiftlint.yml ] || exit 0

# Find merge base against the default branch. Try origin/HEAD first — forks
# often use a non-main default (e.g. `fork`) while keeping an upstream `main`
# whose merge-base would mis-scope the diff to the whole fork history.
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
BASE=""
for candidate in $DEFAULT_BRANCH main master; do
  BASE=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
  [ -n "$BASE" ] && break
done

# Check for Swift files modified in working tree, staged, untracked (a file
# just Written is untracked until git add — plain diff misses it), or recent
# commits on branch
MODIFIED=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD 2>/dev/null || true
  } | sort -u
)
[ -z "$MODIFIED" ] && exit 0

# Exclude generated build output (.build/, DerivedData/) — normally gitignored,
# but the untracked-files pass would sweep it in on repos without a .gitignore.
SWIFT_FILES=$(printf '%s\n' "$MODIFIED" | grep '\.swift$' | grep -v -E '(^|/)(\.build|DerivedData)/' || true)
[ -z "$SWIFT_FILES" ] && exit 0

# Drop files deleted from the working tree — swiftlint errors on missing paths.
EXISTING=$(printf '%s\n' "$SWIFT_FILES" | while IFS= read -r f; do
  [ -f "$f" ] && printf '%s\n' "$f"
done)
[ -z "$EXISTING" ] && exit 0

if ! command -v swiftlint &>/dev/null; then
  echo "WARNING: swiftlint not found in PATH — skipping lint checks" >&2
  exit 0
fi

# Lint just the modified files. SwiftLint takes explicit paths and still
# honors the repo-root .swiftlint.yml (it resolves config from CWD).
FILE_LIST=$(mktemp)
trap 'rm -f "$FILE_LIST"' EXIT
printf '%s\n' "$EXISTING" > "$FILE_LIST"

LINT_ARGS=()
while IFS= read -r f; do
  [ -n "$f" ] && LINT_ARGS+=("$f")
done < "$FILE_LIST"

if ! LINT_OUT=$(swiftlint lint --quiet "${LINT_ARGS[@]}" 2>&1); then
  echo "swiftlint found error-severity violations in modified files" >&2
  printf '%s\n' "$LINT_OUT" | emit_bounded "swiftlint.log" "swiftlint lint <modified files>"
  exit 2
fi

exit 0
