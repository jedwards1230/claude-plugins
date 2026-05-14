#!/usr/bin/env bash
# precommit-default-branch-guard.sh - PreToolUse(Bash) hook for git-tooling.
#
# Blocks `git commit ...` invocations when HEAD is on the repo's default
# branch. The check is dynamic: the default branch is discovered per-repo
# (no "main" hardcoded) and cached so the hot path is cheap.
#
# Honors GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 as an escape hatch when the
# user genuinely wants to commit on the default branch.
#
# Stays silent (exit 0, no output) for anything that is not a real
# `git commit` invocation, so it is safe to attach to all Bash calls.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

# Cheap early-exits before we touch jq/git.
command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
[ "$tool_name" = "Bash" ] || exit 0

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.cmd // empty')"
[ -z "$command_str" ] && exit 0

# Heuristic: cheap substring filter first, then a precise tokenized check.
# We want to fire on:
#   git commit
#   git commit -m "..."
#   git commit --amend
#   git -C path commit
#   git commit -a
# We do NOT want to fire on:
#   git status
#   git log --grep=commit
#   echo "git commit"
case "$command_str" in
  *"git "*commit*|*"git\tcommit"*) ;;
  *) exit 0 ;;
esac

# Cut at command terminators so chained commands do not bleed in.
first_segment="$command_str"
for sep in '&&' '||' ';' '|'; do
  first_segment="${first_segment%%${sep}*}"
done

# Tokenize and look for `git [git-flags] commit`. Use `set -f` to disable
# glob expansion during word-splitting; save/restore the calling shell's flag
# state instead of using a subshell (which trips `set -e` on non-zero exit).
is_git_commit=0
case "$-" in
  *f*) glob_was_off=1 ;;
  *)   glob_was_off=0 ;;
esac
set -f
# shellcheck disable=SC2086
set -- $first_segment
saw_git=0
saw_dash_capital_c=0  # `git -C <path>` — skip the path arg
while [ $# -gt 0 ]; do
  case "$1" in
    git)
      saw_git=1
      ;;
    -C)
      if [ "$saw_git" -eq 1 ]; then
        saw_dash_capital_c=1
      fi
      ;;
    -*)
      # Any other flag — skip silently (e.g. `git --no-pager commit`).
      :
      ;;
    *)
      if [ "$saw_dash_capital_c" -eq 1 ]; then
        saw_dash_capital_c=0  # consume the -C path argument
      elif [ "$saw_git" -eq 1 ]; then
        if [ "$1" = "commit" ]; then
          is_git_commit=1
        fi
        break  # first non-flag token after `git` decides the subcommand
      fi
      ;;
  esac
  shift
done
[ "$glob_was_off" -eq 1 ] || set +f

[ "$is_git_commit" -eq 1 ] || exit 0

# Escape hatch.
if [ "${GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT:-0}" = "1" ]; then
  exit 0
fi

command -v git >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -z "$cwd" ] && cwd="${PWD:-}"
[ -z "$cwd" ] || [ ! -d "$cwd" ] && exit 0

repo_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$repo_root" ] && exit 0

current_branch="$(git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null || true)"
# Detached HEAD or other failure — not our concern.
[ -z "$current_branch" ] && exit 0

cache_dir="${CLAUDE_PLUGIN_DATA:-${CLAUDE_PLUGIN_ROOT:-$HOME/.cache/claude-git-tooling}/.cache}"
cache_file="${cache_dir}/default-branches.json"

default_branch=""
cache_stale_seconds=86400  # 24h
now="$(date +%s)"

if [ -f "$cache_file" ] && [ -r "$cache_file" ]; then
  entry="$(jq -c --arg root "$repo_root" '.[$root] // empty' "$cache_file" 2>/dev/null || true)"
  if [ -n "$entry" ] && [ "$entry" != "null" ]; then
    cached_branch="$(printf '%s' "$entry" | jq -r '.default_branch // empty')"
    cached_at="$(printf '%s' "$entry" | jq -r '.resolved_at // 0')"
    age=$((now - cached_at))
    if [ -n "$cached_branch" ] && [ "$age" -lt "$cache_stale_seconds" ]; then
      default_branch="$cached_branch"
    fi
  fi
fi

# Cache miss / stale — resolve on the fly and update the cache.
if [ -z "$default_branch" ]; then
  if ref="$(git -C "$repo_root" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)"; then
    default_branch="${ref#refs/remotes/origin/}"
  fi
  if [ -z "$default_branch" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    default_branch="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
  fi
  [ -z "$default_branch" ] && exit 0

  # Best-effort cache write. Never fail the hook on cache write errors.
  if mkdir -p "$cache_dir" 2>/dev/null; then
    existing="{}"
    if [ -f "$cache_file" ] && [ -r "$cache_file" ]; then
      if parsed="$(jq -c . "$cache_file" 2>/dev/null)"; then
        existing="$parsed"
      fi
    fi
    if updated="$(printf '%s' "$existing" | jq \
      --arg root "$repo_root" \
      --arg branch "$default_branch" \
      --argjson now "$now" \
      '. + {($root): {default_branch: $branch, resolved_at: $now}}' 2>/dev/null)"; then
      tmp_file="$(mktemp "${cache_file}.XXXXXX" 2>/dev/null || true)"
      if [ -n "$tmp_file" ]; then
        printf '%s\n' "$updated" > "$tmp_file" && mv -f "$tmp_file" "$cache_file" || rm -f "$tmp_file"
      fi
    fi
  fi
fi

# Finally — the actual check.
if [ "$current_branch" = "$default_branch" ]; then
  repo_label="$(basename "$repo_root")"
  reason="Refusing to commit on the default branch (\`${default_branch}\`) of \`${repo_label}\`.

This repo follows a worktree -> branch -> PR workflow. Create a worktree and switch to it before committing:

  git worktree add worktrees/<short-name> -b <type>/<short-desc>
  cd worktrees/<short-name>
  # ... make commits here, then push and open a PR with \`gh pr create\`

See the \`git-worktree\` skill in the git-tooling plugin for the full convention.

Escape hatch (only if you genuinely need to commit on the default branch):
  GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit ..."

  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

exit 0
