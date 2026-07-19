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

# git_ctx_normalize <command_str>
#
# Prints <command_str> with the shell separators `;`, `&&` and `||` separated
# from their neighbours, so the naive word-splitting every caller in this plugin
# does sees `cd /repo ; git push` for the input `cd /repo;git push`.
#
# Without this, that input tokenizes as `cd` `/repo;git` `push` — the word
# `git` never appears as a token at all, so BOTH safety guards ran their
# invocation check, found no `git`, and exited SILENTLY while the command
# committed/pushed on the default branch. `cd /repo&&git push` failed the same
# way. Normalizing is a real fix rather than a "we cannot tell, so ask": the
# resulting context is exactly resolvable.
#
# A separator inside a quoted argument (`git commit -m "a;b"`) is split too.
# That error direction is safe: it can only make a caller see more candidate
# command words and prompt where it previously did not. A bare `|` is
# deliberately NOT split — `cd /repo|git push` is not a real shape, and
# splitting it would turn every `--pretty=format:%h|%s` into spurious prompts.
git_ctx_normalize() {
  printf '%s' "$1" | sed 's/&&/ \&\& /g; s/||/ || /g; s/;/ ; /g'
}

# git_ctx_has_opaque_construct <command_str>
#
# Returns 0 when the command hands part of itself to another shell to evaluate
# (`bash -c ...`, `eval ...`), or changes directory through a mechanism this
# library does not model (`env -C`, `--chdir`).
#
# These are the shapes where the naive tokenizer is CONFIDENTLY WRONG rather
# than merely uncertain: to the outer shell the body of `bash -c '...'` is one
# quoted argument, but word-splitting still exposes a `git push` inside it while
# the `cd` that precedes it is invisible or misattributed. The caller then
# resolves a directory, believes it, and stays silent — which is the fail-open
# this library exists to prevent.
#
# A caller that has recognised a gated invocation must treat a 0 return as
# UNRESOLVABLE and fail closed. Callers with nothing gated to protect can
# ignore it.
git_ctx_has_opaque_construct() {
  local command_str="$1"
  local glob_was_off i n tok prev_is_sep prefix_active

  [ -n "$command_str" ] || return 1
  command_str="$(git_ctx_normalize "$command_str")"

  case "$-" in
    *f*) glob_was_off=1 ;;
    *)   glob_was_off=0 ;;
  esac
  set -f
  # shellcheck disable=SC2086
  set -- $command_str
  local -a toks
  toks=("$@")
  [ "$glob_was_off" -eq 1 ] || set +f

  n=${#toks[@]}
  i=0
  prev_is_sep=1
  # Set while we are inside the argument list of a command prefix that can take
  # a directory-changing flag (`env`, `sudo`). A bare `-C` means something
  # entirely different to `git`, so the flag only counts in that window.
  prefix_active=0
  while [ "$i" -lt "$n" ]; do
    tok="${toks[$i]:-}"

    if [ "$prev_is_sep" -eq 1 ]; then
      # `eval` re-parses its argument; nothing downstream is knowable.
      [ "$tok" = "eval" ] && return 0
      # A nested shell: `bash -c '<anything>'`. Look for the `-c` in its flags.
      case "$tok" in
        bash|sh|zsh|dash|ksh)
          local k
          k=$((i + 1))
          while [ "$k" -lt "$n" ]; do
            case "${toks[$k]:-}" in
              # `-c`, or a short cluster containing it (`-lc`). The `[!-]`
              # keeps a long option like `--color` from matching on its `c`.
              -c|-[!-]*c*) return 0 ;;
              -*) k=$((k + 1)) ;;
              *) break ;;
            esac
          done
          ;;
      esac
    fi

    if [ "$prefix_active" -eq 1 ]; then
      case "$tok" in
        -C|--chdir|--chdir=*) return 0 ;;
      esac
    fi

    case "$tok" in
      "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}"|"!"|do|then|else|elif)
        prev_is_sep=1; prefix_active=0 ;;
      env|sudo)
        prev_is_sep=1; prefix_active=1 ;;
      git|gh)
        prev_is_sep=0; prefix_active=0 ;;
      [A-Za-z_]*=*)
        [ "$prev_is_sep" -eq 1 ] || prev_is_sep=0 ;;
      *)
        [ "$prefix_active" -eq 1 ] || prev_is_sep=0 ;;
    esac
    i=$((i + 1))
  done
  return 1
}

# git_ctx_resolve_dir <payload_cwd> <command_str>
#
# Prints the directory the FINAL command in <command_str> will run in,
# honouring every `cd <path>` along the way. Prints nothing and returns 1 when
# the directory cannot be established with confidence.
#
# Returns 1 (unresolvable) when:
#   * payload_cwd is empty or not a directory, or
#   * a `cd` target contains a shell construct we would have to evaluate to
#     know its value ($var, globs, ~, command substitution, quotes), or
#   * a resolved `cd` target does not exist.
#
# CALLER CONTRACT: pass a command string TERMINATED AT the invocation you care
# about — the guards build `<tokens before the git token> git` for exactly this
# reason. An earlier version instead stopped at the FIRST git/gh command word,
# which looked equivalent but was not: `git fetch && cd /repo-on-main && git
# push` resolved at the `git fetch`, never reached the `cd`, and returned the
# session directory. Both guards then inspected the wrong repo, found a feature
# branch, and stayed silent while the push landed on the default branch. Since
# a git/gh word can legitimately precede the invocation under test, it can no
# longer be a stopping point; the caller marks the boundary instead.
git_ctx_resolve_dir() {
  local payload_cwd="$1" command_str="$2"
  local current_dir tok next glob_was_off i n
  local -a toks

  [ -n "$payload_cwd" ] || return 1
  [ -d "$payload_cwd" ] || return 1
  current_dir="$payload_cwd"

  [ -n "$command_str" ] || { printf '%s' "$current_dir"; return 0; }

  command_str="$(git_ctx_normalize "$command_str")"

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
  command_str="$(git_ctx_normalize "$command_str")"

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
      # Skip binary-level flags, including ones that consume a value. The
      # separated forms (`--git-dir <path>`) must consume their value too:
      # skipping only the flag word left the scan pointing at the PATH instead
      # of the subcommand, so `git --git-dir <path> push` did not register as a
      # push at all.
      j=$((i + 1))
      while [ "$j" -lt "$n" ]; do
        case "${toks[$j]:-}" in
          -C|-c|--git-dir|--work-tree|--namespace) j=$((j + 2)) ;;
          -*) j=$((j + 1)) ;;
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
