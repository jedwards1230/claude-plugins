#!/bin/bash
# Block if cargo clippy reports issues on modified Rust files. Additionally
# run cargo audit (RUSTSEC advisories) when it is installed — a missing
# cargo-audit is not a failure, mirroring how optional tooling degrades.
#
# Per-crate dispatch: walks up from each modified .rs file to its owning
# Cargo.toml and runs clippy/audit from that directory. This handles monorepos
# with multiple crates and Cargo workspaces correctly. If a workspace root
# Cargo.toml (one declaring [workspace]) is present at the repo root, runs
# once from the root.
#
# Within each crate we run `--all-targets` rather than narrowing to specific
# targets — intentional for simplicity. Could be tightened if lint perf
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
  echo "WARNING: cargo not found in PATH — skipping clippy and audit checks" >&2
  exit 0
fi

# clippy ships with rustup's default toolchain but can be absent on minimal
# installs. Probe it the way the hook actually invokes it.
if ! cargo clippy --version &>/dev/null; then
  echo "WARNING: cargo-clippy not found — skipping clippy checks" >&2
  echo "Install: rustup component add clippy" >&2
  HAVE_CLIPPY=false
else
  HAVE_CLIPPY=true
fi

# cargo audit is optional — its absence is not a failure.
if cargo audit --version &>/dev/null; then
  HAVE_AUDIT=true
else
  HAVE_AUDIT=false
fi

if ! $HAVE_CLIPPY && ! $HAVE_AUDIT; then
  # Nothing to run — degrade silently beyond the warning already emitted.
  exit 0
fi

# Workspace mode: a root Cargo.toml declaring [workspace] means run once
# from the root.
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

# Nothing to check (all files orphaned) — exit silently.
[ -z "$CRATES_TO_CHECK" ] && exit 0

# Run clippy/audit in each affected crate; collect ALL failures.
# Temp file pattern (not pipeline-to-while) so FAILED survives in parent shell.
CRATE_LIST=$(mktemp)
CHECK_OUT=$(mktemp)
trap 'rm -f "$CRATE_LIST" "$CHECK_OUT"' EXIT
printf '%s\n' "$CRATES_TO_CHECK" > "$CRATE_LIST"

FAILED=0
while IFS= read -r crate_dir; do
  [ -z "$crate_dir" ] && continue

  if $HAVE_CLIPPY; then
    # -D warnings promotes every clippy/compiler warning to an error.
    if ! (cd "$crate_dir" && cargo clippy --all-targets -- -D warnings) >"$CHECK_OUT" 2>&1; then
      echo "cargo clippy issues in crate: $crate_dir" >&2
      cat "$CHECK_OUT" >&2
      FAILED=1
    fi
  fi

  if $HAVE_AUDIT; then
    if ! (cd "$crate_dir" && cargo audit) >"$CHECK_OUT" 2>&1; then
      echo "cargo audit reported vulnerabilities in crate: $crate_dir" >&2
      cat "$CHECK_OUT" >&2
      FAILED=1
    fi
  fi
done < "$CRATE_LIST"

[ "$FAILED" -eq 1 ] && exit 2
exit 0
