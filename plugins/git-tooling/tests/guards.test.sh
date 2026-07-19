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
# WHY THE HARNESS ASSERTS rc AND stderr, NOT JUST THE DECISION
# ------------------------------------------------------------
# Every fail-open in these guards IS silence. A guard that crashes, a guard that
# exits early on an unparsed command, and a guard that deliberately approves all
# produce the same thing on stdout: nothing. A suite that only compares the
# decision string therefore cannot tell "silent by design" from "silent because
# it fell over", and an assertion of `silent` passes against a hook that does
# nothing at all.
#
# That was not hypothetical here. An earlier version of this file discarded both
# the exit code and stderr; replacing BOTH guards with a script whose whole body
# was `false` still passed 18 of its 35 assertions. So every assertion below now
# also requires exit 0 and empty stderr, and it is enforced inside `check`
# rather than offered as an opt-in helper — an opt-in check is one a new test
# forgets to call.
#
# The hook must also run in THIS shell, not inside `$(...)`. A harness that
# returns its result through a command substitution runs the hook in a subshell,
# so anything it records about rc/stderr in a global is discarded on the way
# out, and the later assertion silently reads the pristine initial values and
# passes no matter what happened.
#
# Override the scripts under test with GUARDS_TEST_SCRIPT_DIR to run the same
# suite against the pre-fix scripts (which must FAIL the headline cases), or
# against a stub, to confirm the suite actually discriminates.
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
# Result of the most recent hook run, recorded in THIS shell.
DEC=""        # the permissionDecision, or empty for silence
DEC_RC=0      # the hook's exit status
DEC_STDERR="" # anything the hook wrote to stderr
ERRFILE="$SANDBOX/hook-stderr"

# run_hook <hook> <cwd> <command>
run_hook() {
  local hook="$1" cwd="$2" cmd="$3" raw
  : > "$ERRFILE"
  # The command substitution here captures only the pipeline's stdout;
  # `run_hook` itself is NOT in a subshell, so the globals below survive.
  raw="$(jq -n --arg cwd "$cwd" --arg cmd "$cmd" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}' \
    | bash "$hook" 2>"$ERRFILE")"
  DEC_RC=$?   # pipefail is on, so this reflects the hook, not jq
  DEC_STDERR="$(cat "$ERRFILE" 2>/dev/null || true)"
  DEC="$(printf '%s' "$raw" \
    | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null || true)"
}

# assert_decision <name> <want: ask|silent>
assert_decision() {
  local name="$1" want="$2" ok=1 why=""
  # A guard is only "silent by design" if it exited cleanly and said nothing on
  # stderr. Without these two, `silent` is satisfied by any failure mode.
  if [ "$DEC_RC" -ne 0 ]; then
    ok=0; why="hook exited rc=$DEC_RC"
  fi
  if [ -n "$DEC_STDERR" ]; then
    ok=0; why="${why:+${why}; }hook wrote stderr: $(printf '%s' "$DEC_STDERR" | head -1)"
  fi
  case "$want" in
    ask)
      [ "$DEC" = "ask" ] || { ok=0; why="${why:+${why}; }want ask, got ${DEC:-<silent>}"; } ;;
    silent)
      [ -z "$DEC" ] || { ok=0; why="${why:+${why}; }want silent, got $DEC"; } ;;
  esac
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n     %s\n' "$name" "$why"
  fi
}

# check_push   <name> <cwd> <command> <want>
# check_commit <name> <cwd> <command> <want>
check_push()   { run_hook "$PUSH_HOOK"   "$2" "$3"; assert_decision "$1" "$4"; }
check_commit() { run_hook "$COMMIT_HOOK" "$2" "$3"; assert_decision "$1" "$4"; }

echo "git-tooling guard regression tests"
echo "  scripts under test: $GUARD_DIR"
echo

# === THE HEADLINE FAIL-OPEN =================================================
# Session cwd is a worktree on feat/x; the command cd's into the main repo,
# which is on the default branch. The old guards read HEAD in the payload cwd,
# saw feat/x, decided nothing was protected, and stayed SILENT while the push /
# commit landed on main.
echo "-- headline fail-open (cd into a default-branch repo) --"
check_push   "force-push: cd into main repo then push must ask" \
  "$WT_FEAT" "cd $MAIN && git push origin" ask
check_commit "commit: cd into main repo then commit must ask" \
  "$WT_FEAT" "cd $MAIN && git commit -m x" ask

# === A git/gh WORD BEFORE THE cd ============================================
# The directory resolver used to settle the context at the FIRST git/gh command
# word, so it never reached a `cd` that came after one. Since fetching or
# checking status before pushing is the common shape, this was the widest hole:
# the resolver returned the SESSION directory, both guards inspected the wrong
# repo, found a feature branch, and stayed silent.
#
# `ls && cd <main> && git push` always worked — the only difference was whether
# the earlier word happened to be git/gh — which is why it read as covered.
echo "-- a git/gh invocation before the cd --"
check_push   "force-push: git fetch, then cd into main, then push must ask" \
  "$WT_FEAT" "git fetch && cd $MAIN && git push" ask
check_commit "commit: git status, then cd into main, then commit must ask" \
  "$WT_FEAT" "git status && cd $MAIN && git commit -m x" ask
check_push   "force-push: gh pr list, then cd into main, then push must ask" \
  "$WT_FEAT" "gh pr list && cd $MAIN && git push" ask
check_push   "force-push: non-git word before the cd still asks (the case that worked)" \
  "$WT_FEAT" "ls && cd $MAIN && git push" ask
# Directional, not blanket: the same shape aimed at a feature branch is silent.
check_push   "force-push: git fetch, then cd into a feature worktree, stays silent" \
  "$MAIN" "git fetch && cd $WT_FEAT && git push" silent
check_commit "commit: git status, then cd into a feature worktree, stays silent" \
  "$MAIN" "git status && cd $WT_FEAT && git commit -m x" silent

# === --git-dir / --work-tree REPOINT git ====================================
# These were skipped as ordinary flags and then never applied, so the guard
# resolved a repo root successfully — for the WRONG repo. A confidently wrong
# answer never trips the fail-closed path, so the result was silence.
echo "-- --git-dir / --work-tree repointing --"
check_push   "force-push: --git-dir= at another repo must ask" \
  "$WT_FEAT" "git --git-dir=$MAIN/.git --work-tree=$MAIN push" ask
check_push   "force-push: separated --git-dir <path> must ask" \
  "$WT_FEAT" "git --git-dir $MAIN/.git push" ask
check_commit "commit: --work-tree= at another repo must ask" \
  "$WT_FEAT" "git --work-tree=$MAIN commit -m x" ask
check_commit "commit: separated --git-dir <path> must ask" \
  "$WT_FEAT" "git --git-dir $MAIN/.git commit -m x" ask

# === A SEPARATOR WITH NO SURROUNDING SPACE ==================================
# `cd /repo;git push` tokenizes as `cd` `/repo;git` `push`. The word `git` never
# appears as a token, so both guards ran their invocation check, found nothing,
# and exited before the gate was ever consulted. The guards now separate `;`
# from its neighbours first, which makes this exactly resolvable rather than
# merely "unknown, so ask".
echo "-- separator with no surrounding space --"
check_push   "force-push: cd <main>;git push must ask" \
  "$WT_FEAT" "cd $MAIN;git push" ask
check_commit "commit: cd <main>;git commit must ask" \
  "$WT_FEAT" "cd $MAIN;git commit -m x" ask
# `&&` and `||` are the same class as `;` and failed the same way.
check_push   "force-push: cd <main>&&git push must ask" \
  "$WT_FEAT" "cd $MAIN&&git push" ask
check_commit "commit: cd <main>&&git commit must ask" \
  "$WT_FEAT" "cd $MAIN&&git commit -m x" ask
check_push   "force-push: cd <main>||git push must ask" \
  "$WT_FEAT" "cd $MAIN||git push" ask
# Proves it is parsed, not blanket-prompted: same shape, feature branch, silent.
check_push   "force-push: cd <feature worktree>;git push stays silent" \
  "$MAIN" "cd $WT_FEAT;git push" silent
check_commit "commit: cd <feature worktree>;git commit stays silent" \
  "$MAIN" "cd $WT_FEAT;git commit -m x" silent

# === COMMANDS EVALUATED BY ANOTHER SHELL ====================================
# Inside `bash -c '...'` or `eval "..."` the body is one quoted argument to the
# outer shell, but naive word-splitting still exposes the `git push` in it while
# the `cd` beside it is invisible or misattributed. The guard resolved a
# directory and believed it. These are unknowable, so they must ask.
echo "-- bash -c / eval wrapped commands --"
check_push   "force-push: bash -c wrapping a cd + push must ask" \
  "$WT_FEAT" "bash -c 'cd $MAIN && git push'" ask
check_commit "commit: eval wrapping a cd + commit must ask" \
  "$WT_FEAT" "eval \"cd $MAIN && git commit -m x\"" ask
check_push   "force-push: sh -c wrapping a push must ask" \
  "$WT_FEAT" "sh -c 'cd $MAIN && git push'" ask
# env -C changes directory by a mechanism this guard does not model.
check_push   "force-push: env -C <main> git push must ask" \
  "$WT_FEAT" "env -C $MAIN git push" ask

# === COMMAND PREFIXES =======================================================
# The push guard handled xargs/sudo/command/time/nice/env; the commit guard had
# no prefix handling at all, so the byte-identical commit shape was silent while
# the push prompted. Both also lost command-word position on a prefix flag that
# takes a bare-word VALUE (`sudo -u name git ...`).
echo "-- command prefixes --"
check_commit "commit: cd into main then sudo git commit must ask" \
  "$WT_FEAT" "cd $MAIN && sudo git commit -m x" ask
check_commit "commit: cd into main then xargs git commit must ask" \
  "$WT_FEAT" "cd $MAIN && xargs -I{} git commit -m x" ask
check_push   "force-push: sudo -u <name> git push must ask" \
  "$MAIN" "sudo -u someone git push" ask
check_commit "commit: sudo -u <name> git commit must ask" \
  "$MAIN" "sudo -u someone git commit -m x" ask
check_push   "force-push: command prefix on a feature branch stays silent" \
  "$WT_FEAT" "sudo -u someone git push" silent

# === THE INVERSE: no false prompts ==========================================
echo "-- inverse: genuine feature-branch work stays silent --"
check_push   "force-push: plain feature-branch push stays silent" \
  "$WT_FEAT" "git push origin" silent
check_push   "force-push: --force-with-lease on a feature branch stays silent" \
  "$WT_FEAT" "git push --force-with-lease" silent
check_commit "commit: plain feature-branch commit stays silent" \
  "$WT_FEAT" "git commit -m 'feat: thing'" silent

# Proves the fix is directional, not blanket prompting: session cwd is the main
# repo on the default branch, but the command cd's into the feature worktree.
check_push   "force-push: cd into feature worktree from main cwd stays silent" \
  "$MAIN" "cd $WT_FEAT && git push" silent
check_commit "commit: cd into feature worktree from main cwd stays silent" \
  "$MAIN" "cd $WT_FEAT && git commit -m x" silent

# === git -C wins over the cd context ========================================
echo "-- git -C targeting --"
check_push   "force-push: git -C <main repo> from feature worktree must ask" \
  "$WT_FEAT" "git -C $MAIN push" ask
check_commit "commit: git -C <main repo> from feature worktree must ask" \
  "$WT_FEAT" "git -C $MAIN commit -m x" ask
check_push   "force-push: git -C <feature worktree> from main cwd stays silent" \
  "$MAIN" "git -C $WT_FEAT push" silent
check_commit "commit: git -C <feature worktree> from main cwd stays silent" \
  "$MAIN" "git -C $WT_FEAT commit -m x" silent
# -C is applied relative to wherever the shell put git, so it composes with cd.
check_commit "commit: cd then relative git -C resolves against the cd target" \
  "$WT_FEAT" "cd $SANDBOX && git -C repo commit -m x" ask

# === escape hatches =========================================================
echo "-- escape hatches --"
check_push   "force-push: inline VAR=1 suppresses the prompt" \
  "$WT_FEAT" "cd $MAIN && GIT_TOOLING_ALLOW_FORCE_PUSH=1 git push origin" silent
check_commit "commit: inline VAR=1 suppresses the prompt" \
  "$WT_FEAT" "cd $MAIN && GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit -m x" silent
# Exported rather than prefixed onto the call: `VAR=1 some_function` leaks the
# assignment into the shell afterwards in some bash versions, which would
# silently disable the gate for every later assertion.
export GIT_TOOLING_ALLOW_FORCE_PUSH=1
check_push   "force-push: env var suppresses the prompt" \
  "$MAIN" "git push --force" silent
unset GIT_TOOLING_ALLOW_FORCE_PUSH
export GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1
check_commit "commit: env var suppresses the prompt" \
  "$MAIN" "git commit -m x" silent
unset GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT

# === fail CLOSED on an unresolvable context =================================
# An unevaluable `cd` target means we cannot know the branch. Silence is not an
# acceptable answer to "I don't know" for a gated command.
echo "-- fail closed on unresolvable context --"
# The single quotes are deliberate: the guard must see a literal, unexpanded
# `$SOME_VAR` in the command string and refuse to guess what it points at.
# shellcheck disable=SC2016
check_push   "force-push: cd \$VAR then push must ask" \
  "$WT_FEAT" 'cd "$SOME_VAR" && git push' ask
# shellcheck disable=SC2016
check_commit "commit: cd \$VAR then commit must ask" \
  "$WT_FEAT" 'cd "$SOME_VAR" && git commit -m x' ask
check_push   "force-push: cd to a nonexistent dir then push must ask" \
  "$WT_FEAT" "cd $SANDBOX/nope && git push" ask
check_commit "commit: cd to a nonexistent dir then commit must ask" \
  "$WT_FEAT" "cd $SANDBOX/nope && git commit -m x" ask
check_commit "commit: git -C to a nonexistent dir must ask" \
  "$WT_FEAT" "git -C $SANDBOX/nope commit -m x" ask

# === non-gated commands stay silent (do not become noisy) ===================
echo "-- non-gated commands stay silent --"
check_push   "force-push: echo git push --force is not an invocation" \
  "$WT_FEAT" "echo git push --force" silent
check_push   "force-push: git status stays silent" \
  "$MAIN" "git status" silent
check_push   "force-push: ls stays silent" \
  "$MAIN" "ls -la" silent
check_commit "commit: echo git commit is not an invocation" \
  "$MAIN" "echo 'git commit -m x'" silent
check_commit "commit: git status stays silent" \
  "$MAIN" "git status" silent
check_commit "commit: ls stays silent" \
  "$MAIN" "ls -la" silent
check_commit "commit: git log --grep=commit stays silent" \
  "$MAIN" "git log --grep=commit" silent
# A wrapped shell with nothing gated in it must not become noisy either — the
# unresolvable-context rule only applies once a real push/commit is recognised.
check_push   "force-push: bash -c with no push stays silent" \
  "$MAIN" "bash -c 'ls -la'" silent
check_commit "commit: bash -c with no commit stays silent" \
  "$MAIN" "bash -c 'ls -la'" silent

# === force detection is branch-independent (must not regress) ===============
echo "-- force detection regardless of branch --"
check_push "force-push: --force on a feature branch still asks" \
  "$WT_FEAT" "git push --force" ask
check_push "force-push: -f on a feature branch still asks" \
  "$WT_FEAT" "git push -f origin feat/x" ask
check_push "force-push: +refspec on a feature branch still asks" \
  "$WT_FEAT" "git push origin +feat/x" ask
check_push "force-push: --force after a cd still asks" \
  "$MAIN" "cd $WT_FEAT && git push --force" ask

# === explicit refspec targeting the default branch ==========================
echo "-- explicit default-branch refspec --"
check_push   "force-push: explicit push to main from a feature branch asks" \
  "$WT_FEAT" "git push origin HEAD:main" ask
check_push   "force-push: push on the default branch asks" \
  "$MAIN" "git push" ask
check_commit "commit: commit on the default branch asks" \
  "$MAIN" "git commit -m x" ask

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
