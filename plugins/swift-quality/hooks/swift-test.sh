#!/bin/bash
# Block if modified Swift files fail `swift test` in their owning SPM package.
#
# Per-package dispatch: walks up from each modified .swift file to its owning
# Package.swift and runs `swift test` from that directory. This covers the
# common iOS-repo layout of an Xcode app target plus local SPM packages.
#
# Deliberately NOT covered here:
#   - App-target files with no owning Package.swift (they belong to the
#     .xcodeproj). Building them needs xcodebuild + a booted simulator —
#     minutes per run, far too slow for a Stop hook. CI owns that gate; the
#     session-start probe notes it so the assistant runs the CI-mirroring
#     xcodebuild commands before handing off a PR.
#   - Packages whose Package.swift declares a platforms: list WITHOUT .macOS —
#     `swift test` on a Mac host builds for macOS, so an iOS-only package
#     would false-fail on every UIKit import. Skipped with a note. (No
#     platforms: list at all means SPM's defaults, which include macOS — run.)
set -euo pipefail

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
SWIFT_SOURCES=$(printf '%s\n' "$MODIFIED" | grep '\.swift$' | grep -v -E '(^|/)(\.build|DerivedData)/' || true)
SWIFT_FILES=$(printf '%s\n' "$SWIFT_SOURCES" | grep -v -E '(^|/)Package\.swift$' || true)
# Manifest-only changes should still re-verify the package they configure.
MANIFESTS=$(printf '%s\n' "$SWIFT_SOURCES" | grep -E '(^|/)Package\.swift$' || true)
[ -z "$SWIFT_FILES" ] && [ -z "$MANIFESTS" ] && exit 0

if ! command -v swift &>/dev/null; then
  echo "WARNING: swift not found in PATH — skipping test checks" >&2
  exit 0
fi

# Walk up from each modified .swift file to its owning package's
# Package.swift. Bash 3.2 compatible: no associative arrays, sort -u dedups.
PACKAGES_TO_CHECK=$(
  {
    printf '%s\n' "$SWIFT_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      d=$(dirname "$f")
      while :; do
        if [ -f "$d/Package.swift" ]; then
          printf '%s\n' "$d"
          break
        fi
        parent=$(dirname "$d")
        if [ "$parent" = "$d" ]; then
          break # reached filesystem root — app-target file, no owning package
        fi
        d=$parent
      done
    done
    printf '%s\n' "$MANIFESTS" | while IFS= read -r m; do
      [ -z "$m" ] && continue
      printf '%s\n' "$(dirname "$m")"
    done
  } | sort -u
)

# Nothing to check (all files app-target-owned) — exit silently. The
# session-start probe already explained the xcodebuild gate lives in CI.
[ -z "$PACKAGES_TO_CHECK" ] && exit 0

PKG_LIST=$(mktemp)
trap 'rm -f "$PKG_LIST"' EXIT
printf '%s\n' "$PACKAGES_TO_CHECK" > "$PKG_LIST"

FAILED=0
while IFS= read -r pkg_dir; do
  [ -z "$pkg_dir" ] && continue
  # iOS-only package guard: a platforms: list that never mentions .macOS
  # cannot build with host `swift test` — skip it rather than false-fail.
  if grep -q 'platforms[[:space:]]*:' "$pkg_dir/Package.swift" 2>/dev/null \
    && ! grep -q '\.macOS(' "$pkg_dir/Package.swift" 2>/dev/null; then
    echo "NOTE: $pkg_dir declares non-macOS platforms only — skipping host swift test (CI covers it)" >&2
    continue
  fi
  # Per-package log slug so a second failing package doesn't overwrite the first's.
  slug=$(printf '%s' "$pkg_dir" | tr -c 'A-Za-z0-9._-' '-')
  if ! TEST_OUT=$( (cd "$pkg_dir" && swift test) 2>&1 ); then
    echo "swift test failed in package: $pkg_dir" >&2
    printf '%s\n' "$TEST_OUT" | emit_bounded "test-$slug.log" "(cd $pkg_dir && swift test)"
    FAILED=1
  fi
done < "$PKG_LIST"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
