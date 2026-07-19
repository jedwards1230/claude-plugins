#!/usr/bin/env bash
# precommit-default-branch-guard.sh - PreToolUse(Bash) hook for git-tooling.
#
# Routes `git commit ...` invocations through the "ask" permission flow when
# HEAD is on the repo's default branch. In interactive mode the user gets a
# prompt; in acceptEdits / bypassPermissions / autonomous flows the surrounding
# mode decides. The check is dynamic: the default branch is discovered per-repo
# (no "main" hardcoded) and cached so the hot path is cheap.
#
# Honors GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 as a per-invocation bypass
# for the prompt, useful when the user already knows they want to commit on
# the default branch (release chores, hotfixes) and doesn't want to be asked.
#
# Stays silent (exit 0, no output) for anything that is not a real
# `git commit` invocation, so it is safe to attach to all Bash calls.
#
# FAIL-CLOSED CONTRACT: once a real `git commit` is recognised, an unresolvable
# repo context must produce an "ask", never silence. The payload `cwd` is the
# SESSION's directory and does not reflect a `cd` inside the command, so the
# directory is resolved from the command string via lib/git-context.sh.

set -euo pipefail

# shellcheck source=lib/git-context.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-context.sh"

ask() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

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
  *"git "*commit*|*"git"$'\t'"commit"*) ;;
  *) exit 0 ;;
esac

# Tokenize the WHOLE command and look for `[VAR=val ...] git [-C path]
# [-flag ...] commit ...` at the head of ANY &&/||/;/|-separated segment.
#
# This hook used to cut command_str at the first separator and inspect only that
# first segment — which made `cd /repo && git commit -m x` invisible (the first
# segment is just `cd /repo`), so the guard exited silently and the commit
# landed on the default branch unprompted. The segment boundaries still matter
# (they stop chained commands bleeding together), so they are preserved here as
# per-segment scanning rather than removed.
#
# Requiring `git` to be the actual command word rejects `echo git commit`,
# `printf "git commit"`, etc. An optional `-C path` is captured since the
# command may target a different repo. Leading `VAR=val` assignments are
# captured to honor the documented inline escape-hatch form
# (`GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit ...`) — that variable
# is exported to the spawned git process, not to this hook, so it must be
# parsed out of command_str.
#
# Use `set -f` to disable glob expansion during word-splitting; save/restore
# the calling shell's flag state instead of using a subshell (which trips
# `set -e` on non-zero exit).
#
# Shell separators are spaced out from their neighbours first: `cd /repo;git
# commit -m x` (and the `&&` form) otherwise tokenizes as `cd` `/repo;git`
# `commit`, so the `git` token the scan below looks for never exists and the
# guard exits silently on a commit that may land on the default branch.
command_str="$(git_ctx_normalize "$command_str")"

# Commands that hand part of themselves to another shell (`bash -c`, `eval`) or
# move the directory in a way this guard does not model (`env -C`). A `git
# commit` found inside one of those is real, but the directory resolved for it
# is not — so it is treated as an unresolvable context, not a resolved one.
opaque_ctx=0
if git_ctx_has_opaque_construct "$command_str"; then
  opaque_ctx=1
fi

is_git_commit=0
inline_escape=0
git_C_path=""
git_dir_override=0
git_tok_index=0
case "$-" in
  *f*) glob_was_off=1 ;;
  *)   glob_was_off=0 ;;
esac
set -f
# shellcheck disable=SC2086
set -- $command_str
toks=("$@")
[ "$glob_was_off" -eq 1 ] || set +f
ntok=${#toks[@]}

i=0
seg_start=1
while [ "$i" -lt "$ntok" ]; do
  t="${toks[$i]:-}"
  case "$t" in
    "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}"|do|then|else|elif|*";")
      seg_start=1; i=$((i + 1)); continue ;;
  esac
  if [ "$seg_start" -ne 1 ]; then
    i=$((i + 1)); continue
  fi

  # Step 1: consume leading `NAME=value` env-var assignments and command
  # prefixes (`sudo`, `env`, `xargs`, ...) with their own arguments.
  #
  # The prefix handling is what the push guard already did and this guard did
  # not, so `cd <repo-on-default-branch> && sudo git commit -m x` stayed SILENT
  # here while the byte-identical push shape prompted. A prefix's arguments can
  # be bare words (`sudo -u name git commit`), so once a prefix is seen every
  # token up to `git` is skipped, not just flag-shaped ones.
  seg_escape=0
  seg_prefix=0
  j=$i
  while [ "$j" -lt "$ntok" ]; do
    case "${toks[$j]:-}" in
      git) break ;;
      "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}") break ;;
      [A-Za-z_]*=*)
        if [ "${toks[$j]%%=*}" = "GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT" ] &&
           [ "${toks[$j]#*=}" = "1" ]; then
          seg_escape=1
        fi
        j=$((j + 1))
        ;;
      xargs|sudo|command|time|nice|env)
        seg_prefix=1
        j=$((j + 1))
        ;;
      *)
        # Only a command prefix's own arguments may sit between the segment
        # start and `git`; anything else means this segment is another command.
        if [ "$seg_prefix" -eq 1 ]; then j=$((j + 1)); else break; fi
        ;;
    esac
  done

  # Step 2: the next token must be `git` exactly.
  if [ "$j" -lt "$ntok" ] && [ "${toks[$j]:-}" = "git" ]; then
    git_start=$j
    j=$((j + 1))
    seg_C_path=""
    seg_dir_override=0
    # Step 3: optional git-level flags, including `-C path` which we capture.
    #
    # `--git-dir` / `--work-tree` repoint git at a different repo, so the
    # directory resolved further down describes the wrong checkout. Skipping
    # them as ordinary flags produced a confidently wrong answer that resolved
    # cleanly, so the fail-closed path never fired.
    while [ "$j" -lt "$ntok" ]; do
      case "${toks[$j]:-}" in
        -C) j=$((j + 1)); seg_C_path="${toks[$j]:-}"; j=$((j + 1)) ;;
        -c) j=$((j + 2)) ;;
        --git-dir|--work-tree) seg_dir_override=1; j=$((j + 2)) ;;
        --git-dir=*|--work-tree=*) seg_dir_override=1; j=$((j + 1)) ;;
        --namespace) j=$((j + 2)) ;;
        -*) j=$((j + 1)) ;;
        *)  break ;;
      esac
    done
    # Step 4: the first non-flag token after the git-level flags is the subcommand.
    if [ "$j" -lt "$ntok" ] && [ "${toks[$j]:-}" = "commit" ]; then
      is_git_commit=1
      git_C_path="$seg_C_path"
      git_dir_override="$seg_dir_override"
      git_tok_index="$git_start"
      inline_escape="$seg_escape"
      break
    fi
  fi
  seg_start=0
  i=$((i + 1))
done

# A wrapped shell body (`eval "cd /repo && git commit -m x"`) is ONE quoted
# argument to the outer shell, so word-splitting can weld the quote characters
# onto its first and last words and the scan above never matches `commit`.
# Retry with quotes stripped, purely to answer "is there a gated verb in here?".
# A wrapped command with no commit in it (`bash -c 'ls -la'`) stays silent.
if [ "$is_git_commit" -eq 0 ] && [ "$opaque_ctx" -eq 1 ]; then
  if git_ctx_has_invocation "$(printf '%s' "$command_str" | sed "s/[\"']//g")" git commit; then
    is_git_commit=1
  fi
fi

[ "$is_git_commit" -eq 1 ] || exit 0

# Escape hatch — honor either the hook process environment or the inline
# assignment parsed out of command_str above.
if [ "${GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT:-0}" = "1" ] || [ "$inline_escape" -eq 1 ]; then
  exit 0
fi

command -v git >/dev/null 2>&1 || exit 0

UNRESOLVED_REASON="Could not determine which repo/branch this \`git commit\` will land on.

The command changes directory (or points \`git -C\` somewhere) in a way this guard
cannot resolve, so it cannot tell whether the commit lands on the default branch.
Rather than let a possible direct-to-default-branch commit through unchecked, it is
asking.

Check the target branch yourself before approving. To skip this check for one command:
  GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit ..."

# A real `git commit` inside an unparseable command, or one repointed by
# --git-dir/--work-tree, has a context we cannot establish — prompt rather than
# resolve a directory that describes some other checkout.
if [ "$opaque_ctx" -eq 1 ] || [ "$git_dir_override" -eq 1 ]; then
  ask "$UNRESOLVED_REASON"
fi

cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -z "$cwd" ] && cwd="${PWD:-}"

# The payload cwd is the SESSION's directory; it does NOT reflect a `cd` inside
# the command (PreToolUse fires before the command runs). Rebuild the directory
# the git invocation will actually run in from the tokens preceding it.
prefix=""
m=0
while [ "$m" -lt "$git_tok_index" ]; do
  prefix="${prefix}${toks[$m]:-} "
  m=$((m + 1))
done
base_dir="$(git_ctx_resolve_dir "$cwd" "${prefix}git" || true)"
[ -n "$base_dir" ] || ask "$UNRESOLVED_REASON"

# `git -C path` wins over the cd context, but is resolved AGAINST it: the shell
# puts git somewhere first, then git applies -C from there.
target_dir="$(git_ctx_apply_dash_c "$base_dir" "$git_C_path" || true)"
[ -n "$target_dir" ] || ask "$UNRESOLVED_REASON"

repo_root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$repo_root" ] && ask "$UNRESOLVED_REASON"

# A detached HEAD is a KNOWN answer ("not on a branch", so not on the default
# branch), not an unresolved one — stay silent for it.
current_branch="$(git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null || true)"
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
    # `gh repo view` without `-R` infers the repo from the current directory,
    # which is the hook process's cwd, not necessarily the target repo. Run it
    # from repo_root so the lookup matches the repo we're actually checking.
    default_branch="$(cd "$repo_root" && gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
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
        if printf '%s\n' "$updated" > "$tmp_file"; then
          mv -f "$tmp_file" "$cache_file" || rm -f "$tmp_file"
        else
          rm -f "$tmp_file"
        fi
      fi
    fi
  fi
fi

# Finally — the actual check.
if [ "$current_branch" = "$default_branch" ]; then
  repo_label="$(basename "$repo_root")"
  reason="About to commit on the default branch (\`${default_branch}\`) of \`${repo_label}\`.

This repo follows a worktree -> branch -> PR workflow. Consider creating a worktree first:

  git worktree add worktrees/<short-name> -b <type>/<short-desc>
  cd worktrees/<short-name>
  # ... make commits here, then push and open a PR with \`gh pr create\`

See the \`git-worktree\` skill in the git-tooling plugin for the full convention.

If this commit on the default branch is intentional (release chore, hotfix, etc.),
approve the prompt. To skip this check entirely on a future commit:
  GIT_TOOLING_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit ..."

  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

exit 0
