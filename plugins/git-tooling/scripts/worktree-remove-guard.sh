#!/usr/bin/env bash
# worktree-remove-guard.sh - PreToolUse(Bash) hook for git-tooling.
#
# Routes *bulk / dynamically-targeted* `git worktree remove --force` invocations
# through the "ask" permission flow. The hazard this guards against: removing
# worktrees in a loop / pipe / glob with `--force`, which silently discards
# uncommitted work — and in a shared-checkout setup (multiple sessions, one set
# of `<repo>/worktrees/*` roots) wipes OTHER sessions' worktrees and their WIP,
# not just your own. Plain `git worktree remove` (no --force) already refuses a
# dirty/unmerged tree, so the danger is specifically force + an unbounded target
# set.
#
# Deliberately NARROW so it does not interrupt normal usage. It fires ONLY when
# BOTH hold:
#   1. the command force-removes worktrees (`--force`/`-f` with `worktree remove`)
#   2. the target set is bulk/dynamic — any of:
#        - an enumerate-then-remove pattern (`git worktree list` in the command)
#        - a loop or fan-out (`for` / `while` / `xargs`)
#        - a glob in the remove target (`*`, `?`, `[`)
#        - two or more `worktree remove` invocations
#
# A single literal-path removal — `git worktree remove --force worktrees/foo` —
# is NOT bulk and passes silently (the normal post-merge cleanup case).
#
# Honors GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE=1 (hook env OR inline assignment
# on the command) as a per-invocation bypass for an intentional bulk force-remove.
#
# Stays silent (exit 0, no output) for anything that is not a forced bulk
# worktree removal, so it is safe to attach to all Bash calls.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
[ "$tool_name" = "Bash" ] || exit 0

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.cmd // empty')"
[ -z "$command_str" ] && exit 0

# Cheap substring gate: must mention worktree AND remove, else not our concern.
case "$command_str" in
  *worktree*remove*) ;;
  *) exit 0 ;;
esac

# Must be an actual `git ... worktree remove` (rejects `echo "worktree remove"`,
# `git worktree list` alone, `git worktree prune`, comments, etc.).
printf '%s' "$command_str" | grep -Eq 'git([[:space:]]+-[^[:space:]]+|[[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+worktree[[:space:]]+remove' || exit 0

# Force present? (`--force` or a `-f` short flag). Trailing boundary allows shell
# terminators (`;`, `|`, `&`, `)`) so `... remove "$wt" --force; done` matches.
printf '%s' "$command_str" | grep -Eq '(^|[[:space:]])(--force|-f)([[:space:];|&)]|$)' || exit 0

# Bulk / dynamic target set?
is_bulk=0
# 1. enumerate-then-remove (the incident pattern)
printf '%s' "$command_str" | grep -Eq 'worktree[[:space:]]+list' && is_bulk=1
# 2. loop / fan-out
printf '%s' "$command_str" | grep -Eq '(^|[[:space:]])(for|while|xargs)([[:space:]]|$)' && is_bulk=1
# 3. glob in a remove target (same segment, before a shell terminator)
printf '%s' "$command_str" | grep -Eq 'worktree[[:space:]]+remove[^|;&]*[*?[]' && is_bulk=1
# 4. multiple remove invocations
if [ "$(printf '%s' "$command_str" | grep -Eo 'worktree[[:space:]]+remove' | wc -l | tr -d '[:space:]')" -ge 2 ]; then
  is_bulk=1
fi
[ "$is_bulk" -eq 1 ] || exit 0

# Escape hatch — env on the hook process, or an inline `VAR=1 ...` assignment.
if [ "${GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE:-0}" = "1" ]; then
  exit 0
fi
printf '%s' "$command_str" | grep -Eq '(^|[[:space:]])GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE=1([[:space:]]|$)' && exit 0

reason="About to **force-remove git worktrees in bulk** (\`--force\` + a loop/pipe/glob/multiple targets).

In a shared checkout, \`<repo>/worktrees/*\` roots are used by multiple sessions at once. A bulk \`git worktree remove --force\` discards uncommitted work and can wipe OTHER sessions' worktrees — not just yours.

Safer approach:
  1. Dry-run: print the resolved target list first, with each target's
     \`git -C <wt> status --porcelain\`, and confirm they are yours + clean.
  2. Drop \`--force\` — plain \`git worktree remove\` REFUSES a dirty/unmerged
     tree, so git's own safety filters out other sessions' work-in-progress.
  3. Remove by the exact paths/branches you created, not a \`/worktrees/\` glob.

If this bulk force-remove is intentional, approve the prompt. To skip this check:
  GIT_TOOLING_ALLOW_FORCE_WORKTREE_REMOVE=1 <your command>"

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $reason
  }
}'
exit 0
