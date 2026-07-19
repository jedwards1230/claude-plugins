#!/usr/bin/env bash
# Regression tests for the two fail-open safety guards:
#   scripts/force-push-guard.sh
#   scripts/precommit-default-branch-guard.sh
#
# Hermetic: builds throwaway git repos under a temp dir. No network, no real
# GitHub, no `gh` — a stub `gh` that always fails auth is put on PATH so the
# commit guard's optional gh fallback can never reach out.
#
# THE HEADLINE BUG both guards had: a PreToolUse payload's `cwd` is the
# SESSION's working directory and does not reflect a `cd` inside the command
# (the hook fires before the command runs). Resolving "which branch/repo" by
# reading HEAD in the payload cwd is therefore wrong for `cd /repo && git ...`,
# and both guards failed OPEN — silently — in exactly that case.
#
# Override the scripts under test with GUARDS_TEST_SCRIPT_DIR to run the same
# suite against the pre-fix scripts (which must FAIL the headline cases).
#
# Run: bash plugins/git-tooling/tests/guards.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_DIR="${GUARDS_TEST_SCRIPT_DIR:-${SCRIPT_DIR}/../scripts}"
PUSH_HOOK="${GUARD_DIR}/force-push-guard.sh"
COMMIT_HOOK="${GUARD_DIR}/precommit-default-branch-guard.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed"
  exit 0
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0
fail=0

# Isolate the default-branch cache from the developer's real one, and keep the
# commit guard's `gh` fallback from ever running.
export CLAUDE_PLUGIN_DATA="$SANDBOX/cache"
mkdir -p "$CLAUDE_PLUGIN_DATA" "$SANDBOX/bin"
cat > "$SANDBOX/bin/gh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$SANDBOX/bin/gh"
export PATH="$SANDBOX/bin:$PATH"

# Escape hatches must come from the command string, never ambient env.
unset GIT_TOOLING_ALLOW_FORCE_PUSH GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT || true

# ------------------------------------------------------------- git fixture ---
# MAIN is a repo checked out on its default branch (`main`); WT_FEAT is a
# worktree of the same repo on `feat/x`. origin/HEAD is set locally (no remote
# needed) so default-branch resolution works offline.
(
  cd "$SANDBOX" || exit 1
  git init -q repo
  cd repo || exit 1
  git config user.email t@example.invalid
  git config user.name test
  git commit -q --allow-empty -m init
  git branch -M main
  git update-ref refs/remotes/origin/main HEAD
  git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  git worktree add -q ../wt-feat -b feat/x main
) >/dev/null 2>&1

MAIN="$SANDBOX/repo"
WT_FEAT="$SANDBOX/wt-feat"

# ---------------------------------------------------------------- harness ---
# decision <hook> <cwd> <command> -> the permissionDecision, or empty if silent.
decision() {
  jq -n --arg cwd "$2" --arg cmd "$3" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}' \
    | bash "$1" 2>/dev/null \
    | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null
}

push_decision()   { decision "$PUSH_HOOK" "$1" "$2"; }
commit_decision() { decision "$COMMIT_HOOK" "$1" "$2"; }

check() { # check <name> <actual> <expected: ask|silent>
  local name="$1" actual="$2" want="$3" ok=1
  case "$want" in
    ask)    [ "$actual" = "ask" ] || ok=0 ;;
    silent) [ -z "$actual" ] || ok=0 ;;
  esac
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n     want: %s  got: %s\n' "$name" "$want" "${actual:-<silent>}"
  fi
}

echo "git-tooling guard regression tests"
echo "  scripts under test: $GUARD_DIR"
echo

# === THE HEADLINE FAIL-OPEN =================================================
# Session cwd is a worktree on feat/x; the command cd's into the main repo,
# which is on the default branch. The old guards read HEAD in the payload cwd,
# saw feat/x, decided nothing was protected, and stayed SILENT while the push /
# commit landed on main.
echo "-- headline fail-open (cd into a default-branch repo) --"
check "force-push: cd into main repo then push must ask" \
  "$(push_decision "$WT_FEAT" "cd $MAIN && git push origin")" ask
check "commit: cd into main repo then commit must ask" \
  "$(commit_decision "$WT_FEAT" "cd $MAIN && git commit -m x")" ask

# === THE INVERSE: no false prompts ==========================================
echo "-- inverse: genuine feature-branch work stays silent --"
check "force-push: plain feature-branch push stays silent" \
  "$(push_decision "$WT_FEAT" "git push origin")" silent
check "force-push: --force-with-lease on a feature branch stays silent" \
  "$(push_decision "$WT_FEAT" "git push --force-with-lease")" silent
check "commit: plain feature-branch commit stays silent" \
  "$(commit_decision "$WT_FEAT" "git commit -m 'feat: thing'")" silent

# Proves the fix is directional, not blanket prompting: session cwd is the main
# repo on the default branch, but the command cd's into the feature worktree.
check "force-push: cd into feature worktree from main cwd stays silent" \
  "$(push_decision "$MAIN" "cd $WT_FEAT && git push")" silent
check "commit: cd into feature worktree from main cwd stays silent" \
  "$(commit_decision "$MAIN" "cd $WT_FEAT && git commit -m x")" silent

# === git -C wins over the cd context ========================================
echo "-- git -C targeting --"
check "force-push: git -C <main repo> from feature worktree must ask" \
  "$(push_decision "$WT_FEAT" "git -C $MAIN push")" ask
check "commit: git -C <main repo> from feature worktree must ask" \
  "$(commit_decision "$WT_FEAT" "git -C $MAIN commit -m x")" ask
check "force-push: git -C <feature worktree> from main cwd stays silent" \
  "$(push_decision "$MAIN" "git -C $WT_FEAT push")" silent
check "commit: git -C <feature worktree> from main cwd stays silent" \
  "$(commit_decision "$MAIN" "git -C $WT_FEAT commit -m x")" silent
# -C is applied relative to wherever the shell put git, so it composes with cd.
check "commit: cd then relative git -C resolves against the cd target" \
  "$(commit_decision "$WT_FEAT" "cd $SANDBOX && git -C repo commit -m x")" ask

# === escape hatches =========================================================
echo "-- escape hatches --"
check "force-push: inline VAR=1 suppresses the prompt" \
  "$(push_decision "$WT_FEAT" "cd $MAIN && GIT_TOOLING_ALLOW_FORCE_PUSH=1 git push origin")" silent
check "commit: inline VAR=1 suppresses the prompt" \
  "$(commit_decision "$WT_FEAT" "cd $MAIN && GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit -m x")" silent
check "force-push: env var suppresses the prompt" \
  "$(GIT_TOOLING_ALLOW_FORCE_PUSH=1 push_decision "$MAIN" "git push --force")" silent
check "commit: env var suppresses the prompt" \
  "$(GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 commit_decision "$MAIN" "git commit -m x")" silent

# === fail CLOSED on an unresolvable context =================================
# An unevaluable `cd` target means we cannot know the branch. Silence is not an
# acceptable answer to "I don't know" for a gated command.
echo "-- fail closed on unresolvable context --"
# The single quotes are deliberate: the guard must see a literal, unexpanded
# `$SOME_VAR` in the command string and refuse to guess what it points at.
# shellcheck disable=SC2016
check "force-push: cd \$VAR then push must ask" \
  "$(push_decision "$WT_FEAT" 'cd "$SOME_VAR" && git push')" ask
# shellcheck disable=SC2016
check "commit: cd \$VAR then commit must ask" \
  "$(commit_decision "$WT_FEAT" 'cd "$SOME_VAR" && git commit -m x')" ask
check "force-push: cd to a nonexistent dir then push must ask" \
  "$(push_decision "$WT_FEAT" "cd $SANDBOX/nope && git push")" ask
check "commit: cd to a nonexistent dir then commit must ask" \
  "$(commit_decision "$WT_FEAT" "cd $SANDBOX/nope && git commit -m x")" ask
check "commit: git -C to a nonexistent dir must ask" \
  "$(commit_decision "$WT_FEAT" "git -C $SANDBOX/nope commit -m x")" ask

# === non-gated commands stay silent (do not become noisy) ===================
echo "-- non-gated commands stay silent --"
check "force-push: echo git push --force is not an invocation" \
  "$(push_decision "$WT_FEAT" "echo git push --force")" silent
check "force-push: git status stays silent" \
  "$(push_decision "$MAIN" "git status")" silent
check "force-push: ls stays silent" \
  "$(push_decision "$MAIN" "ls -la")" silent
check "commit: echo git commit is not an invocation" \
  "$(commit_decision "$MAIN" "echo 'git commit -m x'")" silent
check "commit: git status stays silent" \
  "$(commit_decision "$MAIN" "git status")" silent
check "commit: ls stays silent" \
  "$(commit_decision "$MAIN" "ls -la")" silent
check "commit: git log --grep=commit stays silent" \
  "$(commit_decision "$MAIN" "git log --grep=commit")" silent

# === force detection is branch-independent (must not regress) ===============
echo "-- force detection regardless of branch --"
check "force-push: --force on a feature branch still asks" \
  "$(push_decision "$WT_FEAT" "git push --force")" ask
check "force-push: -f on a feature branch still asks" \
  "$(push_decision "$WT_FEAT" "git push -f origin feat/x")" ask
check "force-push: +refspec on a feature branch still asks" \
  "$(push_decision "$WT_FEAT" "git push origin +feat/x")" ask
check "force-push: --force after a cd still asks" \
  "$(push_decision "$MAIN" "cd $WT_FEAT && git push --force")" ask

# === explicit refspec targeting the default branch ==========================
echo "-- explicit default-branch refspec --"
check "force-push: explicit push to main from a feature branch asks" \
  "$(push_decision "$WT_FEAT" "git push origin HEAD:main")" ask
check "force-push: push on the default branch asks" \
  "$(push_decision "$MAIN" "git push")" ask
check "commit: commit on the default branch asks" \
  "$(commit_decision "$MAIN" "git commit -m x")" ask

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
