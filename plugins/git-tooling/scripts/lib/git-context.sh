#!/usr/bin/env bash
# git-context.sh - shared directory resolution for git-tooling hooks.
#
# THE PROBLEM THIS EXISTS TO SOLVE
# --------------------------------
# A hook payload's `cwd` is the SESSION's working directory. It is not
# necessarily the directory the Bash command runs in: `cd /repo && git push`
# executes in /repo, and `git -C /repo push` targets /repo, while `cwd` keeps
# pointing at wherever the session happens to sit — frequently a worktree
# checked out to an unrelated branch.
#
# Every hook that answered "which branch/repo is this?" by reading HEAD in the
# payload cwd was therefore wrong in exactly those cases, and two of them were
# safety guards that failed OPEN: they inspected the session worktree's feature
# branch, concluded nothing was protected, and stayed silent while the command
# pushed to / committed on the default branch.
#
# THE RULE
# --------
# Decide from the command string alone, or resolve the context the command will
# actually run in — never mix the two. This library implements the second half:
# given the payload cwd and the command string, it returns the directory the
# command's git invocation will actually run in.
#
# Callers that cannot get a confident answer must fail CLOSED (prompt) rather
# than assume the session cwd — that assumption is the bug.

# git_ctx_resolve_dir <payload_cwd> <command_str>
#
# Prints the directory the first git/gh invocation in <command_str> will run in,
# honouring any `cd <path>` that precedes it. Prints nothing and returns 1 when
# the directory cannot be established with confidence.
#
# Returns 1 (unresolvable) when:
#   * payload_cwd is empty or not a directory, or
#   * a `cd` target contains a shell construct we would have to evaluate to
#     know its value ($var, globs, ~, command substitution, quotes), or
#   * a resolved `cd` target does not exist.
#
# `cd` handling deliberately stops at the first git/gh command word: a `cd` that
# comes AFTER the git invocation does not affect it.
git_ctx_resolve_dir() {
  local payload_cwd="$1" command_str="$2"
  local current_dir tok next glob_was_off i n
  local -a toks

  [ -n "$payload_cwd" ] || return 1
  [ -d "$payload_cwd" ] || return 1
  current_dir="$payload_cwd"

  [ -n "$command_str" ] || { printf '%s' "$current_dir"; return 0; }

  # Tokenize with globbing disabled. Save/restore -f rather than using a
  # subshell, which would trip the caller's `set -e` on a non-zero exit.
  case "$-" in
    *f*) glob_was_off=1 ;;
    *)   glob_was_off=0 ;;
  esac
  set -f
  # shellcheck disable=SC2086
  set -- $command_str
  toks=("$@")
  [ "$glob_was_off" -eq 1 ] || set +f

  n=${#toks[@]}
  i=0
  # prev_is_sep tracks command-word position so `echo cd /tmp` is not treated as
  # a directory change and `echo git push` is not treated as a git invocation.
  local prev_is_sep=1
  while [ "$i" -lt "$n" ]; do
    tok="${toks[$i]:-}"

    # Constructs whose directory effect we do not model. Rather than return a
    # confident wrong answer, declare the context unknowable and let the caller
    # fail closed.
    #
    #   `( cd /a && x ) && git push`  — the cd is scoped to the subshell and
    #                                   does NOT apply to the later push
    #   `pushd /a && git push`        — the push DOES run in /a
    #
    # Both previously resolved to the wrong directory, which is the exact
    # fail-open shape this library exists to prevent. Properly modelling
    # subshell scoping and the directory stack is tracked separately; until
    # then these are unresolvable.
    case "$tok" in
      "("|"()"|pushd|popd|dirs) return 1 ;;
    esac

    if [ "$prev_is_sep" -eq 1 ]; then
      case "$tok" in
        git|gh)
          # Reached the invocation — the directory context is settled.
          printf '%s' "$current_dir"
          return 0
          ;;
        cd)
          next="${toks[$((i + 1))]:-}"
          # No argument means `cd` to $HOME; we will not guess at that.
          [ -n "$next" ] || return 1
          case "$next" in
            "&&"|"||"|";"|"|") return 1 ;;
          esac
          # `cd /path; git push` tokenizes the separator onto the path.
          next="${next%;}"
          case "$next" in
            # An embedded separator (`cd /path;git push`) would need real
            # parsing to split safely — fail closed instead of guessing.
            *';'*) return 1 ;;
            # Anything needing shell evaluation is not safely knowable here.
            *'$'*|*'*'*|*'?'*|*'['*|'~'*|*'`'*|*'"'*|*"'"*) return 1 ;;
          esac
          [ -n "$next" ] || return 1
          case "$next" in
            /*) current_dir="$next" ;;
            *)  current_dir="${current_dir%/}/$next" ;;
          esac
          [ -d "$current_dir" ] || return 1
          i=$((i + 2))
          prev_is_sep=1
          continue
          ;;
      esac
    fi

    case "$tok" in
      "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}"|"!"|do|then|else|elif)
        prev_is_sep=1 ;;
      *";")
        prev_is_sep=1 ;;
      [A-Za-z_]*=*)
        # A leading env assignment keeps command-word position.
        [ "$prev_is_sep" -eq 1 ] || prev_is_sep=0 ;;
      *)
        prev_is_sep=0 ;;
    esac
    i=$((i + 1))
  done

  # No git/gh command word found; the trailing context is still the answer.
  printf '%s' "$current_dir"
  return 0
}

# git_ctx_has_invocation <command_str> <binary> <subcmd> [subcmd2]
#
# Returns 0 only when <command_str> really invokes `<binary> [flags] <subcmd>
# [subcmd2]` with <binary> in command-word position. Returns 1 otherwise.
#
# Substring matching is not good enough for this. `rg 'git push' docs/` and
# `gh pr comment 114 --body 'use gh pr create next time'` both contain the
# trigger phrase as DATA, and both then emit output that can be mistaken for a
# push ref block or a PR URL. Deciding the trigger by parsing the command is
# what stops a read-only command from firing a write-shaped reminder.
git_ctx_has_invocation() {
  local command_str="$1" binary="$2" sub1="$3" sub2="${4:-}"
  local glob_was_off i n j prev_is_sep tok
  local -a toks

  [ -n "$command_str" ] || return 1

  case "$-" in
    *f*) glob_was_off=1 ;;
    *)   glob_was_off=0 ;;
  esac
  set -f
  # shellcheck disable=SC2086
  set -- $command_str
  toks=("$@")
  [ "$glob_was_off" -eq 1 ] || set +f

  n=${#toks[@]}
  i=0
  prev_is_sep=1
  while [ "$i" -lt "$n" ]; do
    tok="${toks[$i]:-}"
    if [ "$tok" = "$binary" ] && [ "$prev_is_sep" -eq 1 ]; then
      # Skip binary-level flags, including ones that consume a value.
      j=$((i + 1))
      while [ "$j" -lt "$n" ]; do
        case "${toks[$j]:-}" in
          -C|-c) j=$((j + 2)) ;;
          --git-dir=*|--work-tree=*|--namespace=*|-*) j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      if [ "${toks[$j]:-}" = "$sub1" ]; then
        if [ -z "$sub2" ]; then
          return 0
        fi
        # Allow flags between the two subcommand words (`gh pr -R x create`).
        j=$((j + 1))
        while [ "$j" -lt "$n" ]; do
          case "${toks[$j]:-}" in
            -R|--repo) j=$((j + 2)) ;;
            -*) j=$((j + 1)) ;;
            *) break ;;
          esac
        done
        [ "${toks[$j]:-}" = "$sub2" ] && return 0
      fi
    fi
    case "$tok" in
      "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}"|"!"|do|then|else|elif)
        prev_is_sep=1 ;;
      *";")
        prev_is_sep=1 ;;
      xargs|sudo|command|time|nice|env)
        prev_is_sep=1 ;;
      [A-Za-z_]*=*)
        [ "$prev_is_sep" -eq 1 ] || prev_is_sep=0 ;;
      *)
        prev_is_sep=0 ;;
    esac
    i=$((i + 1))
  done
  return 1
}

# git_ctx_apply_dash_c <base_dir> <git_C_value>
#
# Resolves a `git -C <path>` value against an already-resolved base directory.
# Prints the target directory, or returns 1 if it does not exist.
git_ctx_apply_dash_c() {
  local base="$1" dash_c="$2" target
  [ -n "$base" ] || return 1
  if [ -z "$dash_c" ]; then
    printf '%s' "$base"
    return 0
  fi
  case "$dash_c" in
    *'$'*|*'*'*|*'`'*) return 1 ;;
    /*) target="$dash_c" ;;
    *)  target="${base%/}/$dash_c" ;;
  esac
  [ -d "$target" ] || return 1
  printf '%s' "$target"
  return 0
}
