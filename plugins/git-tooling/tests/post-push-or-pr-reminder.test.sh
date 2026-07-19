#!/usr/bin/env bash
# Regression tests for post-push-or-pr-reminder.sh.
#
# Hermetic: builds throwaway git repos in a temp dir and puts a stub `gh` on
# PATH, so nothing here touches the network or a real GitHub repo.
#
# The headline case is the worktree misfire this hook was fixed for: the hook
# used to resolve the branch from the session's working directory, so pushing
# branch A from a worktree whose own branch was B made it name — and offer to
# `gh pr edit` — B's unrelated open PR.
#
# Run: bash plugins/git-tooling/tests/post-push-or-pr-reminder.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/../scripts/post-push-or-pr-reminder.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed"
  exit 0
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0
fail=0

# ---------------------------------------------------------------- stub gh ---
# PR #114 is headed by `m6` (stands in for the long-lived draft that must never
# be touched). PR #133 is headed by `fix/topic`.
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/gh" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "auth" ] && exit 0
sub="${2:-}"
head=""; repo=""; prev=""; num=""
for a in "$@"; do
  case "$prev" in
    --head) head="$a" ;;
    -R|--repo) repo="$a" ;;
  esac
  prev="$a"
done
case "$sub" in
  list)
    case "$head" in
      m6)        echo '[{"number":114,"title":"DRAFT: do not touch","url":"https://github.com/o/r/pull/114","headRefName":"m6"}]' ;;
      fix/topic) echo '[{"number":133,"title":"fix: topic","url":"https://github.com/o/r/pull/133","headRefName":"fix/topic"}]' ;;
      *)         echo '[]' ;;
    esac
    ;;
  view)
    num="${3:-}"
    case "$num" in
      114) echo '{"title":"DRAFT: do not touch","url":"https://github.com/o/r/pull/114","headRefName":"m6"}' ;;
      133) echo '{"title":"fix: topic","url":"https://github.com/o/r/pull/133","headRefName":"fix/topic"}' ;;
      *)   echo '{}' ;;
    esac
    ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$SANDBOX/bin/gh"
export PATH="$SANDBOX/bin:$PATH"

# ------------------------------------------------------------- git fixture ---
# A repo with two worktrees on different branches, mirroring the real setup:
# the agent's session sits in the `m6` worktree while work happens in another.
#
# `origin`, `origin/main`, and `origin/HEAD` are all real here (pointing at a
# URL that is never contacted) because the commit listing needs all three: it
# resolves its diff base from `origin/HEAD`, diffs against it, and now checks
# the origin slug against the repo the push output named. Without them the
# listing silently never renders and every assertion about it passes vacuously.
(
  cd "$SANDBOX" || exit 1
  git init -q repo
  cd repo || exit 1
  git config user.email t@example.invalid
  git config user.name test
  git commit -q --allow-empty -m init
  git branch -M main
  git branch m6
  git remote add origin git@github.com:o/r.git
  git update-ref refs/remotes/origin/main main
  # A real clone has origin/HEAD; the listing resolves its diff base from it.
  git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  git worktree add -q ../wt-m6 m6
  git worktree add -q ../wt-fix -b fix/topic main
  cd ../wt-fix || exit 1
  git commit -q --allow-empty -m "feat: only-in-o-r"
) >/dev/null 2>&1

# A SEPARATE repo that happens to have a same-named `fix/topic` branch, with an
# `origin` pointing somewhere else entirely. Standing in this checkout while
# the push output says `o/r` is the misattribution case: branch existence alone
# used to be enough to list commits, so THIS repo's commits appeared under the
# other repo's PR number.
(
  cd "$SANDBOX" || exit 1
  git init -q other
  cd other || exit 1
  git config user.email t@example.invalid
  git config user.name test
  git commit -q --allow-empty -m init
  git branch -M main
  git remote add origin git@github.com:other/elsewhere.git
  git update-ref refs/remotes/origin/main main
  git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  git checkout -q -b fix/topic
  git commit -q --allow-empty -m "chore: only-in-other-repo"
) >/dev/null 2>&1

WT_M6="$SANDBOX/wt-m6"
WT_FIX="$SANDBOX/wt-fix"
OTHER_REPO="$SANDBOX/other"

# ---------------------------------------------------------------- harness ---
# The hook's result lands in three globals, which every assertion then reads:
#   HOOK_OUT    - the emitted additionalContext (empty when the hook is silent)
#   HOOK_RC     - the hook's exit status
#   HOOK_STDERR - path to a file holding the hook's stderr
#
# THESE MUST BE SET IN THE CALLER'S SHELL, so `run` is never invoked inside a
# command substitution. An earlier harness did exactly that — `got="$(run ...)"`
# — which ran `run` in a SUBSHELL and discarded the globals with it. Every
# exit-status assertion then read the parent's pristine defaults (rc 0, empty
# stderr path, `[ ! -s "" ]` true) and became incapable of failing: a stub hook
# doing `echo BOOM >&2; exit 7` passed all of them.
HOOK_OUT=""
HOOK_RC=0
HOOK_STDERR=""

# run_json <payload> — invoke the hook on a raw event payload.
run_json() {
  local raw
  # Inside the sandbox so the EXIT trap cleans these up.
  HOOK_STDERR="$(mktemp "$SANDBOX/stderr.XXXXXX")"
  # The command substitution here wraps only the pipeline, not `run_json`
  # itself, so the assignments below still land in the caller. `pipefail` is on,
  # so $? reflects the hook rather than the printf feeding it.
  raw="$(printf '%s' "$1" | bash "$HOOK" 2>"$HOOK_STDERR")"
  HOOK_RC=$?
  HOOK_OUT="$(printf '%s' "$raw" \
    | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)"
}

# run <cwd> <command> <stdout> <stderr>
run() {
  run_json "$(jq -n \
    --arg cwd "$1" --arg cmd "$2" --arg out "$3" --arg err "$4" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd},
      tool_response:{stdout:$out, stderr:$err, interrupted:false}}')"
}

# check <name> <mode: contains|lacks|empty> [needle]
#
# Reads HOOK_OUT/HOOK_RC/HOOK_STDERR from the preceding `run`.
#
# The clean-exit check is folded in here rather than offered as a separate
# opt-in assertion, because it is exactly the property a test author forgets to
# assert: a hook that DIES emits no stdout, which is byte-identical to a hook
# that deliberately stayed silent. Checking rc and stderr on every assertion is
# what tells those two apart, so it is structural and cannot be skipped.
check() {
  local name="$1" mode="$2" needle="${3:-}" actual="$HOOK_OUT" ok=1 why=""
  if [ "$HOOK_RC" -ne 0 ]; then
    ok=0; why=" (hook exited $HOOK_RC)"
  elif [ -s "$HOOK_STDERR" ]; then
    ok=0; why=" (hook stderr: $(head -3 "$HOOK_STDERR" | tr '\n' ' '))"
  else
    case "$mode" in
      empty)    [ -z "$actual" ] || ok=0 ;;
      contains) printf '%s' "$actual" | grep -qF -- "$needle" || ok=0 ;;
      # A `lacks` assertion on EMPTY output proves nothing: a hook that went
      # silent "lacks" every needle. Require real output first.
      lacks)
        if [ -z "$actual" ]; then
          ok=0
        elif printf '%s' "$actual" | grep -qF -- "$needle"; then
          ok=0
        fi ;;
    esac
  fi
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s%s\n     got: %s\n' \
      "$name" "$why" "${actual:-<empty>}"
  fi
}

PUSH_FIX_ERR="To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic"

echo "post-push-or-pr-reminder regression tests"

# --- THE REGRESSION -------------------------------------------------------
# Session cwd is the m6 worktree; the push happened in the fix worktree.
#
# The bare `git push` form is the one that actually misfired in production: with
# no ref on the command line the old code fell back to reading HEAD from the
# session cwd, landing on `m6` and naming m6's unrelated draft PR. (The explicit
# `git push origin <ref>` form below never misfired — the old parser read the
# ref off the command string — so it is a weaker case and is kept only as a
# guard against regressing the parse.)
run "$WT_M6" "cd $WT_FIX && git push" "" "$PUSH_FIX_ERR"
check "bare push from mismatched worktree: names the pushed branch's PR" contains "#133"
check "bare push from mismatched worktree: not the cwd worktree's PR" lacks "#114"
check "bare push from mismatched worktree: no gh pr edit on the wrong PR" lacks "gh pr edit 114"

run "$WT_M6" "cd $WT_FIX && git push -u origin fix/topic" "" "$PUSH_FIX_ERR"
check "explicit-ref push from mismatched worktree: names the pushed PR" contains "#133"
check "explicit-ref push from mismatched worktree: not the cwd PR" lacks "#114"

# `gh pr create` run from a different worktree than the session cwd.
CREATE_OUT="https://github.com/o/r/pull/133"
run "$WT_M6" "cd $WT_FIX && gh pr create --fill" "$CREATE_OUT" ""
check "worktree pr create: names the created PR" contains "#133"
check "worktree pr create: not the cwd worktree's PR" lacks "#114"

# --- fail-safe silence ----------------------------------------------------
run "$WT_FIX" "git push" "" "Everything up-to-date"
check "up-to-date push stays silent" empty

run "$WT_FIX" "git push --dry-run origin fix/topic" "" "$PUSH_FIX_ERR"
check "dry-run push stays silent" empty

run_json "$(jq -n --arg c "$WT_FIX" \
  '{tool_name:"Bash",cwd:$c,tool_input:{command:"git push"}}')"
check "missing tool_response stays silent" empty

run "$WT_FIX" "git push origin --delete gone" "" "To github.com:o/r.git
 - [deleted]         gone"
check "branch deletion stays silent" empty

run "$WT_FIX" "git push origin a b" "" "To github.com:o/r.git
 * [new branch]      a -> a
 * [new branch]      b -> b"
check "multi-ref push is ambiguous, stays silent" empty

run "$WT_FIX" "git push" "" "To github.com:o/r.git
 * [new branch]      no-pr -> no-pr"
check "pushed branch with no open PR stays silent" empty

run "$WT_FIX" "gh pr create --fill" "" "pull request create failed"
check "failed gh pr create (no URL) stays silent" empty

run "$WT_FIX" "ls -la" "f" ""
check "unrelated command stays silent" empty

run "$WT_FIX" "git push a fix/topic && git push b fix/topic" "" "To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic
To github.com:other/repo.git
 * [new branch]      fix/topic -> fix/topic"
check "push to two remotes is unattributable, stays silent" empty

# Real GitHub output carries trailing whitespace. Built with printf so the
# spaces survive editors, git hooks, and whitespace-trimming linters.
TRAILING_WS_ERR="$(printf 'To https://github.com/o/r.git   \n * [new branch]      fix/topic -> fix/topic   \n')"
# Asserted with the trailing space so a slug of `o/r.git   ` cannot satisfy it
# as a prefix match.
run "$WT_FIX" "git push" "" "$TRAILING_WS_ERR"
check "trailing whitespace on the To line still yields the repo slug" contains "gh pr checks 133 -R o/r"

# GitHub prints a `remote:` banner on first push of a branch. It is server text,
# not a ref update, and must not be mistaken for one.
run "$WT_FIX" "git push -u origin fix/topic" "" "remote:
remote: Create a pull request for 'fix/topic' on GitHub by visiting:
remote:      https://github.com/o/r/pull/new/fix/topic
remote:
To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic"
check "remote: banner lines are not parsed as ref updates" contains "#133"

run "$WT_FIX" "git push" "" "remote: hook: rewrote m6 -> m6
To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic"
check "a remote: line containing -> cannot invent a branch" lacks "#114"

# `gh pr create` prints the new-PR URL form during push; only /pull/<number> counts.
run "$WT_FIX" "gh pr create --fill" "https://github.com/o/r/pull/new/fix/topic" ""
check "pull/new/<branch> URL is not mistaken for a created PR" empty

# --- reviewer repros: read-only commands must never fire ------------------
# Each of these named a PR and emitted `gh pr edit <that PR>` before the fix.
# The trigger is now decided by PARSING the command, and the push parser is
# anchored to a real `To <remote>` line.

# A ripgrep hit whose output happens to contain `a -> b`. The repo's own README
# and CONTRIBUTING contain "git push", and design docs routinely contain arrows.
run "$WT_M6" "rg 'git push' docs/" "docs/plan.md:12: rebase main -> m6 before pushing
docs/plan.md:40: then run git push" ""
check "rg for 'git push' does not fire (no To anchor)" empty

# No trailing path argument: the old parser found no refspec, fell back to
# reading HEAD in the session cwd, and named that worktree's PR.
run "$WT_M6" "rg 'git push'" "docs/plan.md:12: rebase main -> m6" ""
check "rg with no path argument does not fire" empty

# A comment command that merely mentions creating a PR, whose output URL is the
# COMMENT url — previously truncated at /pull/114 by a substring match.
run "$WT_M6" "gh pr comment 114 --body 'use gh pr create next time'" \
  "https://github.com/o/r/pull/114#issuecomment-999" ""
check "gh pr comment does not fire as a pr_create" empty

run "$WT_FIX" "gh pr create --fill" "https://github.com/o/r/pull/133#issuecomment-1" ""
check "a PR URL with a fragment is not a created PR" empty

run "$WT_FIX" "gh pr create --fill" "see https://github.com/o/r/pull/133 for details" ""
check "a PR URL quoted mid-line is not a created PR" empty

# A REJECTED push carries a `->` and previously read as a successful push.
run "$WT_FIX" "git push" "" "To github.com:o/r.git
 ! [rejected]        fix/topic -> fix/topic (fetch first)
error: failed to push some refs"
check "rejected push does not claim success" empty

run "$WT_FIX" "git push" "" "fix/topic -> fix/topic"
check "ref-shaped output with no To line does not fire" empty

run "$WT_FIX" "git push -n origin fix/topic" "" "$PUSH_FIX_ERR"
check "-n short dry-run flag stays silent" empty

run "$WT_FIX" "git push -vn origin fix/topic" "" "$PUSH_FIX_ERR"
check "-n in a short cluster stays silent" empty

# A dry-run flag only counts if it belongs to the PUSH. Scanning the whole
# command string read `head`'s `-n` as git's and silently dropped the reminder
# for a push that really did reach the remote.
run "$WT_FIX" "git push 2>&1 | head -n 20" "" "$PUSH_FIX_ERR"
check "a later command's -n does not suppress a real push" contains "#133"

run "$WT_FIX" "git push && sleep -n 1" "" "$PUSH_FIX_ERR"
check "a chained command's -n does not suppress a real push" contains "#133"

run "$WT_FIX" "git push; other-tool --dry-run" "" "$PUSH_FIX_ERR"
check "a --dry-run belonging to a later command does not suppress" contains "#133"

run "$WT_FIX" "echo 'remember to git push'" "remember to git push" ""
check "echo mentioning git push does not fire" empty

# --- correct-by-construction cases ---------------------------------------
run "$WT_FIX" "git push" "" "$PUSH_FIX_ERR"
check "plain push in the right cwd names its PR" contains "#133"

run "$WT_FIX" "git push origin HEAD:fix/topic" "" "To github.com:o/r.git
 * [new branch]      HEAD -> fix/topic"
check "src:dst push uses the remote-side ref" contains "#133"

run "$WT_FIX" "git push" "" "$PUSH_FIX_ERR"
check "referenced command is scoped to the repo from the push output" contains "gh pr checks 133 -R o/r"

# --- commit listing is gated on repo identity, not just branch existence ---
# The listing is cosmetic, but attributing one repo's commits to another repo's
# PR is worse than printing nothing.
check "correct repo lists its commits" contains "only-in-o-r"
check "correct repo labels the listing" contains "Recent commits on this branch"

# Hook context must never hand the agent a ready-to-run mutating command. A
# wrong read-only suggestion costs a minute; a wrong mutating one destroys work.
for verb in "gh pr edit" "gh pr merge" "gh pr close" "gh pr ready"; do
  check "never emits a mutating command ($verb)" lacks "$verb"
done

# Same branch name, different repo, same push output. Branch existence is
# satisfied; repo identity is not.
run "$OTHER_REPO" "git push" "" "$PUSH_FIX_ERR"
check "different repo with a same-named branch still names the right PR" contains "#133"
check "different repo's commits are not listed under this PR" lacks "only-in-other-repo"
check "different repo omits the commit listing entirely" lacks "Recent commits on this branch"

run "$WT_M6" "cd $WT_FIX && gh pr create --fill" "$CREATE_OUT" ""
for verb in "gh pr edit" "gh pr merge" "gh pr close" "gh pr ready"; do
  check "pr_create path never emits a mutating command ($verb)" lacks "$verb"
done

run "$WT_FIX" "git push --force-with-lease" "" "To github.com:o/r.git
 + 1111111...2222222 fix/topic -> fix/topic (forced update)"
check "force-push update is recognised" contains "#133"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
