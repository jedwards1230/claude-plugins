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
(
  cd "$SANDBOX" || exit 1
  git init -q repo
  cd repo || exit 1
  git config user.email t@example.invalid
  git config user.name test
  git commit -q --allow-empty -m init
  git branch -M main
  git branch m6
  git worktree add -q ../wt-m6 m6
  git worktree add -q ../wt-fix -b fix/topic main
) >/dev/null 2>&1

WT_M6="$SANDBOX/wt-m6"
WT_FIX="$SANDBOX/wt-fix"

# ---------------------------------------------------------------- harness ---
# run <cwd> <command> <stdout> <stderr>  -> hook's additionalContext (or empty)
# Sets HOOK_RC / HOOK_STDERR as a side effect so callers can assert the hook
# exited cleanly. A hook that dies under `set -e` produces no output, which
# would otherwise look identical to a deliberate "stay silent".
HOOK_RC=0
HOOK_STDERR=""
run() {
  local raw
  HOOK_STDERR="$(mktemp)"
  raw="$(jq -n \
    --arg cwd "$1" --arg cmd "$2" --arg out "$3" --arg err "$4" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd},
      tool_response:{stdout:$out, stderr:$err, interrupted:false}}' \
    | bash "$HOOK" 2>"$HOOK_STDERR")"
  HOOK_RC=$?
  printf '%s' "$raw" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}

# Every silent path must be silent BY DESIGN (exit 0), never by crashing.
check_clean_exit() {
  local name="$1"
  if [ "$HOOK_RC" -eq 0 ] && [ ! -s "$HOOK_STDERR" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s (rc=%s, stderr: %s)\n' \
      "$name" "$HOOK_RC" "$(head -3 "$HOOK_STDERR" 2>/dev/null)"
  fi
}

check() { # check <name> <actual> <mode: contains|lacks|empty> [needle]
  local name="$1" actual="$2" mode="$3" needle="${4:-}" ok=1
  case "$mode" in
    empty)    [ -z "$actual" ] || ok=0 ;;
    contains) printf '%s' "$actual" | grep -qF -- "$needle" || ok=0 ;;
    # A `lacks` assertion on EMPTY output proves nothing: a hook that crashed
    # or went silent "lacks" every needle. Require real output first.
    lacks)
      if [ -z "$actual" ]; then
        ok=0
      elif printf '%s' "$actual" | grep -qF -- "$needle"; then
        ok=0
      fi ;;
  esac
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n     got: %s\n' "$name" "${actual:-<empty>}"
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
got="$(run "$WT_M6" "cd $WT_FIX && git push" "" "$PUSH_FIX_ERR")"
check "bare push from mismatched worktree: names the pushed branch's PR" "$got" contains "#133"
check "bare push from mismatched worktree: not the cwd worktree's PR" "$got" lacks "#114"
check "bare push from mismatched worktree: no gh pr edit on the wrong PR" "$got" lacks "gh pr edit 114"

got="$(run "$WT_M6" "cd $WT_FIX && git push -u origin fix/topic" "" "$PUSH_FIX_ERR")"
check "explicit-ref push from mismatched worktree: names the pushed PR" "$got" contains "#133"
check "explicit-ref push from mismatched worktree: not the cwd PR" "$got" lacks "#114"

# `gh pr create` run from a different worktree than the session cwd.
CREATE_OUT="https://github.com/o/r/pull/133"
got="$(run "$WT_M6" "cd $WT_FIX && gh pr create --fill" "$CREATE_OUT" "")"
check "worktree pr create: names the created PR" "$got" contains "#133"
check "worktree pr create: not the cwd worktree's PR" "$got" lacks "#114"

# --- fail-safe silence ----------------------------------------------------
check "up-to-date push stays silent" \
  "$(run "$WT_FIX" "git push" "" "Everything up-to-date")" empty
check "dry-run push stays silent" \
  "$(run "$WT_FIX" "git push --dry-run origin fix/topic" "" "$PUSH_FIX_ERR")" empty
check "missing tool_response stays silent" \
  "$(jq -n --arg c "$WT_FIX" '{tool_name:"Bash",cwd:$c,tool_input:{command:"git push"}}' \
     | bash "$HOOK" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext // empty')" empty
check "branch deletion stays silent" \
  "$(run "$WT_FIX" "git push origin --delete gone" "" "To github.com:o/r.git
 - [deleted]         gone")" empty
check "multi-ref push is ambiguous, stays silent" \
  "$(run "$WT_FIX" "git push origin a b" "" "To github.com:o/r.git
 * [new branch]      a -> a
 * [new branch]      b -> b")" empty
check "pushed branch with no open PR stays silent" \
  "$(run "$WT_FIX" "git push" "" "To github.com:o/r.git
 * [new branch]      no-pr -> no-pr")" empty
check "failed gh pr create (no URL) stays silent" \
  "$(run "$WT_FIX" "gh pr create --fill" "" "pull request create failed")" empty
check "unrelated command stays silent" \
  "$(run "$WT_FIX" "ls -la" "f" "")" empty
check "push to two remotes is unattributable, stays silent" \
  "$(run "$WT_FIX" "git push a fix/topic && git push b fix/topic" "" "To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic
To github.com:other/repo.git
 * [new branch]      fix/topic -> fix/topic")" empty

# Real GitHub output carries trailing whitespace. Built with printf so the
# spaces survive editors, git hooks, and whitespace-trimming linters.
TRAILING_WS_ERR="$(printf 'To https://github.com/o/r.git   \n * [new branch]      fix/topic -> fix/topic   \n')"
# Asserted with the trailing space so a slug of `o/r.git   ` cannot satisfy it
# as a prefix match.
check "trailing whitespace on the To line still yields the repo slug" \
  "$(run "$WT_FIX" "git push" "" "$TRAILING_WS_ERR")" contains "gh pr checks 133 -R o/r"

# GitHub prints a `remote:` banner on first push of a branch. It is server text,
# not a ref update, and must not be mistaken for one.
check "remote: banner lines are not parsed as ref updates" \
  "$(run "$WT_FIX" "git push -u origin fix/topic" "" "remote:
remote: Create a pull request for 'fix/topic' on GitHub by visiting:
remote:      https://github.com/o/r/pull/new/fix/topic
remote:
To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic")" contains "#133"
check "a remote: line containing -> cannot invent a branch" \
  "$(run "$WT_FIX" "git push" "" "remote: hook: rewrote m6 -> m6
To github.com:o/r.git
 * [new branch]      fix/topic -> fix/topic")" lacks "#114"
# `gh pr create` prints the new-PR URL form during push; only /pull/<number> counts.
check "pull/new/<branch> URL is not mistaken for a created PR" \
  "$(run "$WT_FIX" "gh pr create --fill" "https://github.com/o/r/pull/new/fix/topic" "")" empty

# --- reviewer repros: read-only commands must never fire ------------------
# Each of these named a PR and emitted `gh pr edit <that PR>` before the fix.
# The trigger is now decided by PARSING the command, and the push parser is
# anchored to a real `To <remote>` line.

# A ripgrep hit whose output happens to contain `a -> b`. The repo's own README
# and CONTRIBUTING contain "git push", and design docs routinely contain arrows.
check "rg for 'git push' does not fire (no To anchor)" \
  "$(run "$WT_M6" "rg 'git push' docs/" "docs/plan.md:12: rebase main -> m6 before pushing
docs/plan.md:40: then run git push" "")" empty
check_clean_exit "rg repro exits cleanly"
# No trailing path argument: the old parser found no refspec, fell back to
# reading HEAD in the session cwd, and named that worktree's PR.
check "rg with no path argument does not fire" \
  "$(run "$WT_M6" "rg 'git push'" "docs/plan.md:12: rebase main -> m6" "")" empty
check_clean_exit "rg-no-path repro exits cleanly"

# A comment command that merely mentions creating a PR, whose output URL is the
# COMMENT url — previously truncated at /pull/114 by a substring match.
check "gh pr comment does not fire as a pr_create" \
  "$(run "$WT_M6" "gh pr comment 114 --body 'use gh pr create next time'" \
     "https://github.com/o/r/pull/114#issuecomment-999" "")" empty
check_clean_exit "gh pr comment repro exits cleanly"

check "a PR URL with a fragment is not a created PR" \
  "$(run "$WT_FIX" "gh pr create --fill" "https://github.com/o/r/pull/133#issuecomment-1" "")" empty
check "a PR URL quoted mid-line is not a created PR" \
  "$(run "$WT_FIX" "gh pr create --fill" "see https://github.com/o/r/pull/133 for details" "")" empty

# A REJECTED push carries a `->` and previously read as a successful push.
check "rejected push does not claim success" \
  "$(run "$WT_FIX" "git push" "" "To github.com:o/r.git
 ! [rejected]        fix/topic -> fix/topic (fetch first)
error: failed to push some refs")" empty
check_clean_exit "rejected push exits cleanly"

check "ref-shaped output with no To line does not fire" \
  "$(run "$WT_FIX" "git push" "" "fix/topic -> fix/topic")" empty
check "-n short dry-run flag stays silent" \
  "$(run "$WT_FIX" "git push -n origin fix/topic" "" "$PUSH_FIX_ERR")" empty
check "echo mentioning git push does not fire" \
  "$(run "$WT_FIX" "echo 'remember to git push'" "remember to git push" "")" empty

# --- correct-by-construction cases ---------------------------------------
check "plain push in the right cwd names its PR" \
  "$(run "$WT_FIX" "git push" "" "$PUSH_FIX_ERR")" contains "#133"
check "src:dst push uses the remote-side ref" \
  "$(run "$WT_FIX" "git push origin HEAD:fix/topic" "" "To github.com:o/r.git
 * [new branch]      HEAD -> fix/topic")" contains "#133"
got="$(run "$WT_FIX" "git push" "" "$PUSH_FIX_ERR")"
check "referenced command is scoped to the repo from the push output" "$got" contains "gh pr checks 133 -R o/r"

# Hook context must never hand the agent a ready-to-run mutating command. A
# wrong read-only suggestion costs a minute; a wrong mutating one destroys work.
for verb in "gh pr edit" "gh pr merge" "gh pr close" "gh pr ready"; do
  check "never emits a mutating command ($verb)" "$got" lacks "$verb"
done
got_create="$(run "$WT_M6" "cd $WT_FIX && gh pr create --fill" "$CREATE_OUT" "")"
for verb in "gh pr edit" "gh pr merge" "gh pr close" "gh pr ready"; do
  check "pr_create path never emits a mutating command ($verb)" "$got_create" lacks "$verb"
done
check "force-push update is recognised" \
  "$(run "$WT_FIX" "git push --force-with-lease" "" "To github.com:o/r.git
 + 1111111...2222222 fix/topic -> fix/topic (forced update)")" contains "#133"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
