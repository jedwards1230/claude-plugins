#!/usr/bin/env bash
# Unit tests for scripts/lib/git-context.sh.
#
# This library decides which directory a hook should inspect. Two safety guards
# depend on it, and both previously failed OPEN by assuming the session cwd, so
# its "I cannot tell" return is as load-bearing as its answers: callers treat a
# non-zero return as "fail closed and prompt".
#
# Run: bash plugins/git-tooling/tests/git-context.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib/git-context.sh
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/../scripts/lib/git-context.sh"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/repo" "$SANDBOX/repo/nested" "$SANDBOX/wt"

pass=0
fail=0

# expect_dir <name> <expected> <payload_cwd> <command>
expect_dir() {
  local name="$1" want="$2" cwd="$3" cmd="$4" got rc
  got="$(git_ctx_resolve_dir "$cwd" "$cmd")"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n     want: %s\n      got: %s (rc=%s)\n' "$name" "$want" "${got:-<empty>}" "$rc"
  fi
}

# expect_unresolvable <name> <payload_cwd> <command>
expect_unresolvable() {
  local name="$1" cwd="$2" cmd="$3" got rc
  got="$(git_ctx_resolve_dir "$cwd" "$cmd")"; rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$got" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s (expected non-zero + empty)\n      got: %s (rc=%s)\n' "$name" "${got:-<empty>}" "$rc"
  fi
}

echo "git-context resolve_dir tests"

expect_dir "no cd: payload cwd wins" \
  "$SANDBOX/repo" "$SANDBOX/repo" "git push"
expect_dir "absolute cd before git" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && git push"
expect_dir "relative cd before git" \
  "$SANDBOX/repo/nested" "$SANDBOX/repo" "cd nested && git push"
expect_dir "chained cds accumulate" \
  "$SANDBOX/repo/nested" "$SANDBOX/wt" "cd $SANDBOX/repo && cd nested && git push"
expect_dir "cd AFTER git does not affect the git invocation" \
  "$SANDBOX/wt" "$SANDBOX/wt" "git push && cd $SANDBOX/repo"
expect_dir "cd as an argument is not a directory change" \
  "$SANDBOX/wt" "$SANDBOX/wt" "echo cd $SANDBOX/repo && git push"
expect_dir "leading env assignment keeps command-word position" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && FOO=1 git push"
expect_dir "gh is a recognised invocation boundary" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && gh pr create"
expect_dir "semicolon separator (separator tokenized onto the path)" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo; git push"
expect_unresolvable "separator with no space is not guessed at" \
  "$SANDBOX/wt" "cd $SANDBOX/repo;git push"
expect_dir "no git at all: trailing context returned" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && ls"

# --- must fail closed -----------------------------------------------------
# shellcheck disable=SC2016  # literal, unexpanded on purpose — that is the case under test
expect_unresolvable "cd to a variable is unresolvable" \
  "$SANDBOX/wt" 'cd "$TARGET" && git push'
# shellcheck disable=SC2016
expect_unresolvable "cd to an unexpanded var without quotes is unresolvable" \
  "$SANDBOX/wt" 'cd $TARGET && git push'
expect_unresolvable "cd to a glob is unresolvable" \
  "$SANDBOX/wt" "cd $SANDBOX/re* && git push"
expect_unresolvable "cd to a tilde path is unresolvable" \
  "$SANDBOX/wt" "cd ~/somewhere && git push"
# shellcheck disable=SC2016
expect_unresolvable "cd to a command substitution is unresolvable" \
  "$SANDBOX/wt" 'cd `pwd`/x && git push'
expect_unresolvable "cd to a nonexistent directory is unresolvable" \
  "$SANDBOX/wt" "cd $SANDBOX/does-not-exist && git push"
expect_unresolvable "bare cd (to \$HOME) is unresolvable" \
  "$SANDBOX/wt" "cd && git push"
# Directory constructs we do not model must be unknowable, never guessed:
# guessing here is fail-open in a safety guard.
expect_unresolvable "subshell cd is unresolvable (its cd does not escape)" \
  "$SANDBOX/wt" "( cd $SANDBOX/repo && echo x ) && git push"
expect_unresolvable "pushd is unresolvable (it DOES change the dir)" \
  "$SANDBOX/wt" "pushd $SANDBOX/repo && git push"
expect_unresolvable "popd is unresolvable" \
  "$SANDBOX/wt" "popd && git push"
expect_unresolvable "missing payload cwd is unresolvable" \
  "" "git push"
expect_unresolvable "payload cwd that is not a directory is unresolvable" \
  "$SANDBOX/nope" "git push"

echo
echo "git-context apply_dash_c tests"
got="$(git_ctx_apply_dash_c "$SANDBOX/wt" "")"
if [ "$got" = "$SANDBOX/wt" ]; then pass=$((pass+1)); echo "  ok   empty -C returns the base"; else fail=$((fail+1)); echo "  FAIL empty -C returns the base (got $got)"; fi
got="$(git_ctx_apply_dash_c "$SANDBOX/wt" "$SANDBOX/repo")"
if [ "$got" = "$SANDBOX/repo" ]; then pass=$((pass+1)); echo "  ok   absolute -C overrides the base"; else fail=$((fail+1)); echo "  FAIL absolute -C overrides the base (got $got)"; fi
got="$(git_ctx_apply_dash_c "$SANDBOX/repo" "nested")"
if [ "$got" = "$SANDBOX/repo/nested" ]; then pass=$((pass+1)); echo "  ok   relative -C resolves against the base"; else fail=$((fail+1)); echo "  FAIL relative -C resolves against the base (got $got)"; fi
if git_ctx_apply_dash_c "$SANDBOX/wt" "$SANDBOX/missing" >/dev/null 2>&1; then
  fail=$((fail+1)); echo "  FAIL nonexistent -C must return non-zero"
else
  pass=$((pass+1)); echo "  ok   nonexistent -C returns non-zero"
fi

# --- the library must not corrupt the caller's shell state ----------------
echo
echo "caller-state safety"
set -- alpha beta gamma
git_ctx_resolve_dir "$SANDBOX/repo" "cd $SANDBOX/wt && git push" >/dev/null || true
if [ "$1" = "alpha" ] && [ "$3" = "gamma" ] && [ "$#" -eq 3 ]; then
  pass=$((pass+1)); echo "  ok   caller's positional parameters survive"
else
  fail=$((fail+1)); echo "  FAIL caller's positional parameters were clobbered (\$#=$# \$1=${1:-})"
fi
case "$-" in
  *f*) fail=$((fail+1)); echo "  FAIL globbing left disabled after the call" ;;
  *)   pass=$((pass+1)); echo "  ok   globbing restored after the call" ;;
esac

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
