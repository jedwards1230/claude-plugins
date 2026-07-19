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
# The resolver answers for the FINAL command in the string, so a caller asks
# about a particular invocation by terminating the string AT it. It used to stop
# at the first git/gh word instead, which silently returned the pre-cd directory
# for the shape below and was the widest fail-open in both guards.
expect_dir "a git word no longer stops the scan: a later cd is honoured" \
  "$SANDBOX/repo" "$SANDBOX/wt" "git fetch && cd $SANDBOX/repo && git"
expect_dir "gh before the cd is honoured too" \
  "$SANDBOX/repo" "$SANDBOX/wt" "gh pr list && cd $SANDBOX/repo && git"
expect_dir "chained git invocations resolve at the caller's terminator" \
  "$SANDBOX/repo/nested" "$SANDBOX/wt" \
  "git status && cd $SANDBOX/repo && git add -A && cd nested && git"
expect_dir "cd as an argument is not a directory change" \
  "$SANDBOX/wt" "$SANDBOX/wt" "echo cd $SANDBOX/repo && git push"
expect_dir "leading env assignment keeps command-word position" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && FOO=1 git push"
expect_dir "gh is a recognised invocation boundary" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo && gh pr create"
expect_dir "semicolon separator (separator tokenized onto the path)" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo; git push"
# This used to be documented as "unresolvable", which READ as handled but was
# not: neither guard ever called the resolver on this shape. `cd /repo;git push`
# tokenizes as `cd` `/repo;git` `push`, so the word `git` does not exist, both
# guards found no invocation, and exited silently — the resolver's opinion was
# never consulted. Separating `;` first makes the context exactly resolvable.
expect_dir "separator with no surrounding space is normalized, not guessed at" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo;git push"
expect_dir "no-space separator with a trailing cd still accumulates" \
  "$SANDBOX/repo/nested" "$SANDBOX/wt" "cd $SANDBOX/repo;cd nested;git push"
expect_dir "no-space && is normalized too" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo&&git push"
expect_dir "no-space || is normalized too" \
  "$SANDBOX/repo" "$SANDBOX/wt" "cd $SANDBOX/repo||git push"
# A bare `|` is deliberately left alone, so a format string containing one does
# not manufacture a separator (and a spurious prompt) out of an argument.
expect_dir "a bare pipe character is not split" \
  "$SANDBOX/repo" "$SANDBOX/repo" "git log --pretty=format:%h|%s"
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
echo "git-context has_opaque_construct tests"

# expect_opaque <name> <command>  /  expect_clear <name> <command>
expect_opaque() {
  if git_ctx_has_opaque_construct "$2"; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$1"
  else
    fail=$((fail + 1)); printf '  FAIL %s (expected opaque, got clear)\n' "$1"
  fi
}
expect_clear() {
  if git_ctx_has_opaque_construct "$2"; then
    fail=$((fail + 1)); printf '  FAIL %s (expected clear, got opaque)\n' "$1"
  else
    pass=$((pass + 1)); printf '  ok   %s\n' "$1"
  fi
}

# These hand part of the command to another shell, or move the directory by a
# mechanism the resolver does not model. The tokenizer can still see a git verb
# inside them while resolving the WRONG directory for it — a confidently wrong
# answer, which never trips a caller's fail-closed path.
expect_opaque "bash -c is opaque"   "bash -c 'cd /somewhere && git push'"
expect_opaque "sh -c is opaque"     "sh -c 'git push'"
expect_opaque "eval is opaque"      'eval "cd /somewhere && git commit -m x"'
expect_opaque "env -C is opaque"    "env -C /somewhere git push"
expect_opaque "--chdir is opaque"   "env --chdir /somewhere git push"
expect_clear  "a plain command is clear"        "git push"
expect_clear  "cd + git is clear"               "cd /somewhere && git push"
expect_clear  "git -C is NOT opaque (modelled)" "git -C /somewhere push"
expect_clear  "sudo without -C is clear"        "sudo -u someone git push"
# `bash` as an argument rather than a command word must not trip the check.
expect_clear  "the word bash as an argument is clear" "echo bash -c hello"

echo
echo "git-context has_invocation tests"

expect_invocation() { # <name> <expect: yes|no> <command> <binary> <sub1> [sub2]
  local name="$1" want="$2" cmd="$3" bin="$4" s1="$5" s2="${6:-}" got=no
  if git_ctx_has_invocation "$cmd" "$bin" "$s1" "$s2"; then got=yes; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

expect_invocation "plain git push"        yes "git push" git push
expect_invocation "echo git push is data" no  "echo git push" git push
# The separated flag forms consume a VALUE. Skipping only the flag word left the
# scan pointing at the path instead of the subcommand, so a real push did not
# register as one at all.
expect_invocation "--git-dir= attached form"  yes "git --git-dir=/r/.git push" git push
expect_invocation "--git-dir separated form"  yes "git --git-dir /r/.git push" git push
expect_invocation "--work-tree separated form" yes "git --work-tree /r push" git push
expect_invocation "-C separated form"         yes "git -C /r push" git push
# A no-space separator must not hide the invocation.
expect_invocation "no-space separator"        yes "cd /r;git push" git push
expect_invocation "gh pr create two-word"     yes "gh pr create --fill" gh pr create
expect_invocation "gh pr comment is not create" no "gh pr comment 1 --body 'gh pr create'" gh pr create

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
