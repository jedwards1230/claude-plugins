#!/usr/bin/env bash
# worktree-editpath-guard.sh - PreToolUse(Edit|Write|MultiEdit|NotebookEdit) hook
# for git-tooling.
#
# Catches the "wrong copy" mistake: a session working in a git worktree
# (`<repo>/worktrees/<branch>/`, this project's standard convention — see the
# git-worktree skill) issues an Edit/Write/MultiEdit/NotebookEdit call that
# targets the equivalent path in that repo's MAIN checkout instead, silently
# editing the copy the session is NOT reviewing/testing. Session-history
# review found this class of self-correction recurring often enough to be
# worth a hard stop.
#
# Fires ONLY for that one direction: cwd resolves into a worktree AND the
# edit target is the same repo's main checkout. It deliberately stays silent
# for everything else, including:
#   - cwd in the main checkout, editing a file inside a worktree (a normal,
#     deliberate pattern — e.g. reviewing/fixing up a worktree from outside it)
#   - cwd in one worktree, editing a file inside a SIBLING worktree of the
#     same repo (unusual but not the "wrong copy" hazard this guards against)
#   - anything outside a worktrees/ tree, or outside the repo entirely
#
# Bails out with pure string checks before touching git (the common case: cwd
# isn't under any worktrees/ tree, or the edit target isn't under the same
# repo root) and only shells out to `git rev-parse` to confirm cwd is a
# genuine LINKED worktree of that repo before denying — failing open (silent
# allow) on any ambiguity, so a directory that merely has "worktrees" as a
# path component, but isn't real worktree state, is never falsely blocked.
#
# Honors GIT_TOOLING_ALLOW_MAIN_CHECKOUT_EDIT=1 in the hook's environment as a
# standing bypass (there's no shell command to carry an inline assignment on,
# unlike the Bash-only guards in this plugin).
#
# Stays silent (exit 0, no output) for anything that isn't a confirmed
# worktree -> main-checkout edit, so it is safe to attach to all
# Edit/Write/MultiEdit/NotebookEdit calls.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
case "$tool_name" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
cwd="${cwd%/}"
[ -n "$cwd" ] || exit 0

# Fast bail-out: cwd isn't inside any worktrees/ tree at all (the common
# case) -- no git subprocess needed. `%%` removal of the longest matching
# suffix anchors at the FIRST "/worktrees/" occurrence, which is what we want
# since this convention always nests worktrees directly under a repo root.
repo_root="${cwd%%/worktrees/*}"
[ "$repo_root" != "$cwd" ] || exit 0

after="${cwd#*/worktrees/}"
branch="${after%%/*}"
[ -n "$branch" ] || exit 0
worktree_root="$repo_root/worktrees/$branch"

path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
[ -n "$path" ] || exit 0

# Tool schemas require an absolute path already; resolve defensively rather
# than risk a relative path accidentally matching a prefix check below.
case "$path" in
  /*) ;;
  *) path="$cwd/$path" ;;
esac
path="${path%/}"

# Fast bail-out: edit target isn't under this repo root at all.
case "$path" in
  "$repo_root"/*) ;;
  *) exit 0 ;;
esac

# Target is inside *some* worktrees/ dir of this repo (the session's own, or
# a sibling) -- not the hazard this guards against, which is specifically
# "landed in the main checkout". Silent allow.
case "$path" in
  "$worktree_root"/*|"$worktree_root") exit 0 ;;
  "$repo_root"/worktrees/*) exit 0 ;;
esac

command -v git >/dev/null 2>&1 || exit 0

# String checks alone can't prove cwd is really a linked git worktree of this
# repo (a non-git directory that merely has "worktrees" as a path component
# would false-positive). Confirm with git before denying.
git_dir="$(git -C "$worktree_root" rev-parse --git-dir 2>/dev/null || true)"
[ -n "$git_dir" ] || exit 0
common_dir="$(git -C "$worktree_root" rev-parse --git-common-dir 2>/dev/null || true)"
[ -n "$common_dir" ] || exit 0

case "$git_dir" in /*) ;; *) git_dir="$worktree_root/$git_dir" ;; esac
case "$common_dir" in /*) ;; *) common_dir="$worktree_root/$common_dir" ;; esac

# A main worktree's git-dir == git-common-dir; only a LINKED worktree
# differs (its git-dir lives under .git/worktrees/<name>).
[ "$git_dir" != "$common_dir" ] || exit 0

git_repo_root="$(cd -P "$(dirname "$common_dir")" 2>/dev/null && pwd -P || true)"
[ -n "$git_repo_root" ] || exit 0
canon_repo_root="$(cd -P "$repo_root" 2>/dev/null && pwd -P || true)"
[ -n "$canon_repo_root" ] || exit 0
[ "$git_repo_root" = "$canon_repo_root" ] || exit 0

if [ "${GIT_TOOLING_ALLOW_MAIN_CHECKOUT_EDIT:-0}" = "1" ]; then
  exit 0
fi

suggested="$worktree_root${path#"$repo_root"}"

reason="This session is working in worktree \`$worktree_root\`, but \`$path\` is in the MAIN checkout of the same repo.

Editing the main checkout from a worktree session silently edits a copy this session isn't reviewing or testing.

Edit \`$suggested\` instead. If the main checkout is really what you intend (e.g. cleaning up after a merge), cd/switch the session out of the worktree first, or set GIT_TOOLING_ALLOW_MAIN_CHECKOUT_EDIT=1 in the environment to bypass this check for the session."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
