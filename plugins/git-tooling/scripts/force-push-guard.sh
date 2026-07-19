#!/usr/bin/env bash
# force-push-guard.sh - PreToolUse(Bash) hook for git-tooling.
#
# Routes a `git push` through the "ask" permission flow when it crosses one of
# the gated boundaries from the project's push policy, while staying SILENT for
# the normal feature-branch flow (including the pre-approved
# `--force-with-lease` rebase hygiene on feature branches). It fires ONLY when:
#
#   1. the push uses a NON-LEASE force — `--force` / `-f` / a `+refspec` — which
#      is always gated regardless of branch; OR
#   2. the push TARGETS the repo's default branch (or a literal main/master) —
#      direct-to-main and force-to-main both need per-push approval.
#
# It deliberately does NOT fire on:
#   - a plain `git push` of a feature branch (the normal PR flow), or
#   - `--force-with-lease` / `--force-if-includes` to a NON-default branch
#     (pre-approved rebase-onto-moved-main hygiene).
#
# Why a hook (not settings): `git push` is not allow-listed, so the gate is
# purely behavioral today — and the one documented violation happened when
# SUBAGENTS were instructed to force-push. Settings don't reliably gate
# subagent Bash calls; a plugin hook fires for them too.
#
# Reuses the default-branch cache populated by
# session-start-default-branch-cache.sh (same file the commit guard reads).
#
# Honors GIT_TOOLING_ALLOW_FORCE_PUSH=1 (hook env OR inline `VAR=1 ...`
# assignment on the command) as a per-invocation bypass.
#
# Stays silent (exit 0, no output) for anything that is not a gated push, so it
# is safe to attach to all Bash calls.
#
# FAIL-CLOSED CONTRACT: for a command that IS a gated candidate (a real
# `git push`), an unresolvable repo/branch context must produce an "ask", never
# silence. The payload `cwd` is the SESSION's directory and does not reflect a
# `cd` inside the command, so the directory is resolved from the command string
# via lib/git-context.sh; when that cannot be answered confidently we prompt.

set -euo pipefail

# shellcheck source=lib/git-context.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-context.sh"

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty')"
[ "$tool_name" = "Bash" ] || exit 0

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.cmd // empty')"
[ -z "$command_str" ] && exit 0

# Cheap substring gate: must mention push, else not our concern.
case "$command_str" in
  *push*) ;;
  *) exit 0 ;;
esac

# Space out shell separators first: `cd /repo;git push` (and the `&&` form)
# otherwise tokenizes as `cd` `/repo;git` `push`, the word `git` never appears,
# and the scan below finds no invocation to gate — a silent pass on a push that
# may land on the default branch.
command_str="$(git_ctx_normalize "$command_str")"

# Constructs that hand part of the command to another shell (`bash -c`, `eval`)
# or move the directory in a way this guard does not model (`env -C`). The
# tokenizer can still see a `git push` inside them while resolving the WRONG
# directory for it, so any push found in such a command is treated as having an
# unknowable context rather than a confidently-resolved one.
opaque_ctx=0
if git_ctx_has_opaque_construct "$command_str"; then
  opaque_ctx=1
fi

# Tokenize with globbing disabled. Save/restore the -f flag instead of using a
# subshell (which would trip set -e on a non-zero exit).
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

# Resolve the repo root / current / default branch for a `cd`-aware base
# directory plus a `git -C` value. Single-slot memo in plain vars — bash 3.2
# (the macOS system bash) has no associative arrays. Commands almost always
# have one git context, so a one-entry memo keyed by "<base>|<-C>" is enough; a
# different key just recomputes. Default-branch resolution is read-from-cache
# then a local origin/HEAD lookup — no network/gh in the push hot path.
#
# _memo_ok is the fail-closed signal: 1 only when a real repo root was found for
# the resolved directory. 0 means "I do not know which repo this push targets".
_memo_done=0
_memo_key=""
_memo_cur=""
_memo_def=""
_memo_ok=0

payload_cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
[ -z "$payload_cwd" ] && payload_cwd="${PWD:-}"

# Directory the git invocation at token index $1 will actually run in. Rebuilt
# from the tokens that precede it so a `cd` earlier in the chain is honoured.
# Prints nothing (and returns 1) when the context is not confidently knowable.
ctx_base_for() {
  local upto="$1" prefix="" m=0
  while [ "$m" -lt "$upto" ]; do
    prefix="${prefix}${toks[$m]:-} "
    m=$((m + 1))
  done
  git_ctx_resolve_dir "$payload_cwd" "${prefix}git"
}

resolve_repo() {
  # $1 = cd-resolved base dir (may be empty => unresolvable), $2 = git -C value.
  # Populates _memo_cur / _memo_def / _memo_ok.
  local base="$1" gitC="$2" key target_dir repo_root cur def entry cached_branch cache_dir cache_file ref
  key="${base}|${gitC}"
  if [ "$_memo_done" = "1" ] && [ "$_memo_key" = "$key" ]; then
    return 0
  fi
  _memo_done=1
  _memo_key="$key"
  _memo_cur=""
  _memo_def=""
  _memo_ok=0
  command -v git >/dev/null 2>&1 || return 0
  [ -n "$base" ] || return 0
  [ -d "$base" ] || return 0

  # `git -C` wins over the cd context, but is resolved AGAINST it: the shell
  # puts git somewhere first, then git applies -C from there.
  target_dir="$(git_ctx_apply_dash_c "$base" "$gitC" || true)"
  [ -n "$target_dir" ] || return 0

  repo_root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -z "$repo_root" ] && return 0
  _memo_ok=1

  # A detached HEAD leaves _memo_cur empty — that is a KNOWN answer ("not on a
  # branch", so not on the default branch), not an unresolved one.
  cur="$(git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null || true)"
  _memo_cur="$cur"

  # Default branch: cache first, then a local origin/HEAD symbolic-ref.
  cache_dir="${CLAUDE_PLUGIN_DATA:-${CLAUDE_PLUGIN_ROOT:-$HOME/.cache/claude-git-tooling}/.cache}"
  cache_file="${cache_dir}/default-branches.json"
  def=""
  if [ -f "$cache_file" ] && [ -r "$cache_file" ]; then
    entry="$(jq -c --arg root "$repo_root" '.[$root] // empty' "$cache_file" 2>/dev/null || true)"
    if [ -n "$entry" ] && [ "$entry" != "null" ]; then
      cached_branch="$(printf '%s' "$entry" | jq -r '.default_branch // empty')"
      [ -n "$cached_branch" ] && def="$cached_branch"
    fi
  fi
  if [ -z "$def" ]; then
    if ref="$(git -C "$repo_root" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)"; then
      def="${ref#refs/remotes/origin/}"
    fi
  fi
  _memo_def="$def"
}

is_protected() {
  # $1 = branch name, $2 = base dir, $3 = git -C value. Protected if it equals
  # the resolved default branch, or is a literal main/master (cheap fallback on
  # cache miss).
  local branch="$1" base="$2" gitC="$3"
  [ -z "$branch" ] && return 1
  case "$branch" in
    main|master) return 0 ;;
  esac
  resolve_repo "$base" "$gitC"
  [ -n "$_memo_def" ] && [ "$branch" = "$_memo_def" ] && return 0
  return 1
}

non_lease_force=0
inline_escape=0
targets_protected=0
# Set when a real `git push` was found but its repo/branch context could not be
# established. Gated candidate + unknown context => ask (never silence).
unresolved_ctx=0

# Track whether the current token is in command-word position, so a literal
# `git` that is an ARGUMENT (e.g. `echo git push --force`) is not mistaken for
# a real invocation. True at the start and after a control operator, a command
# prefix (xargs/sudo/...), or a leading env-assignment.
prev_is_sep=1
# Sticky across a command prefix (`xargs -I{} git ...`) so the prefix's own
# flags / `{}` placeholders don't reset command-word position before `git`.
cmd_prefix_active=0

i=0
while [ "$i" -lt "$n" ]; do
  t="${toks[$i]:-}"
  case "$t" in
    GIT_TOOLING_ALLOW_FORCE_PUSH=1) inline_escape=1; prev_is_sep=1; i=$((i+1)); continue ;;
  esac
  if [ "$t" = "git" ] && [ "$prev_is_sep" -eq 1 ]; then
    # Skip git-level flags; capture -C path.
    #
    # `--git-dir` / `--work-tree` REPOINT git at another repo entirely, so the
    # cd-resolved directory below describes the wrong checkout. These used to be
    # skipped as ordinary flags, which produced a confidently wrong answer — the
    # repo root resolved fine, so the fail-closed path never fired and the guard
    # stayed silent. Applying them properly means reimplementing git's own
    # discovery rules; flagging the context unknowable is the honest answer.
    j=$((i+1)); gitC=""; gitdir_override=0
    while [ "$j" -lt "$n" ]; do
      case "${toks[$j]:-}" in
        -C) j=$((j+1)); gitC="${toks[$j]:-}"; j=$((j+1)) ;;
        -c) j=$((j+2)) ;;                       # -c takes a key=val value
        --git-dir|--work-tree) gitdir_override=1; j=$((j+2)) ;;
        --git-dir=*|--work-tree=*) gitdir_override=1; j=$((j+1)) ;;
        --namespace) j=$((j+2)) ;;
        --namespace=*) j=$((j+1)) ;;
        -*) j=$((j+1)) ;;
        *) break ;;
      esac
    done
    if [ "$j" -lt "$n" ] && [ "${toks[$j]:-}" = "push" ]; then
      # Parse the push window: flags + remote + refspec(s), until a shell
      # terminator token. Determine force-ness and the target branch.
      k=$((j+1)); seen_positional=0; explicit_target=""
      while [ "$k" -lt "$n" ]; do
        tk="${toks[$k]:-}"
        case "$tk" in
          "&&"|"||"|"|"|";"|"|&"|";;") break ;;
          *";") break ;;                        # e.g. `$b;` or `done;`
        esac
        case "$tk" in
          --force) non_lease_force=1 ;;
          --force-with-lease|--force-with-lease=*|--force-if-includes|--force-if-includes=*) : ;;
          -o|--push-option) k=$((k+1)) ;;       # consumes a value
          --*) : ;;                             # other long flag (incl. --follow-tags) — ignore
          -*)
            case "$tk" in
              *f*) non_lease_force=1 ;;          # short cluster containing f => force
              *) : ;;
            esac ;;
          *)
            if [ "$seen_positional" -eq 0 ]; then
              seen_positional=1                 # first positional = remote
            else
              # refspec: leading '+' is a force marker; dst is after the colon.
              case "$tk" in
                +*) non_lease_force=1; tk="${tk#+}" ;;
              esac
              dst="${tk##*:}"
              dst="${dst#refs/heads/}"
              [ -n "$dst" ] && explicit_target="$dst"
            fi ;;
        esac
        k=$((k+1))
      done

      # A real push was found. If the command as a whole is unparseable, or this
      # invocation repoints git with --git-dir/--work-tree, the directory below
      # is not the one the push actually targets — say so instead of trusting it.
      if [ "$opaque_ctx" -eq 1 ] || [ "$gitdir_override" -eq 1 ]; then
        unresolved_ctx=1
      fi

      # The directory this `git` will really run in — NOT the payload cwd.
      base_dir="$(ctx_base_for "$i" || true)"

      # Effective target: explicit refspec dst, or HEAD's current branch.
      eff_target="$explicit_target"
      if [ -z "$eff_target" ] || [ "$eff_target" = "HEAD" ]; then
        resolve_repo "$base_dir" "$gitC"
        eff_target="$_memo_cur"
        # No repo root => we cannot say which branch this push lands on.
        [ "$_memo_ok" -eq 1 ] || unresolved_ctx=1
      fi
      if is_protected "$eff_target" "$base_dir" "$gitC"; then
        targets_protected=1
      fi
      # Stopped at a terminator (or end) — next token starts a new command.
      prev_is_sep=1; cmd_prefix_active=0
      i=$k
      continue
    fi
    # `git` but not a push — its args follow until a separator.
    prev_is_sep=0; cmd_prefix_active=0
    i=$j
    continue
  fi
  # Update command-word position for the next token.
  case "$t" in
    "&&"|"||"|"|"|";"|";;"|"|&"|"("|")"|"{"|"}"|"!"|\
    do|then|else|elif) prev_is_sep=1; cmd_prefix_active=0 ;;
    xargs|sudo|command|time|nice|env) prev_is_sep=1; cmd_prefix_active=1 ;;
    *";") prev_is_sep=1; cmd_prefix_active=0 ;;     # e.g. `done;`
    [A-Za-z_]*=*) prev_is_sep=1 ;;                  # env-assignment keeps cmd-word context
    # Inside a command prefix's arguments the real command word has not arrived
    # yet, so command-word position must survive them ALL — not just the ones
    # that look like flags. `sudo -u name git push` puts a bare `name` here, and
    # treating it as an ordinary word meant the following `git` was not in
    # command-word position and the push went ungated.
    *)
      if [ "$cmd_prefix_active" -eq 1 ]; then prev_is_sep=1; else prev_is_sep=0; fi ;;
  esac
  i=$((i+1))
done

# A wrapped shell body (`bash -c 'cd /repo && git push'`) is ONE quoted argument
# to the outer shell, so word-splitting welds the quote characters onto its
# first and last words — the scan above compares `push'` against `push` and
# finds no invocation at all. Retry the invocation test with quotes stripped,
# purely to answer "is there a gated verb anywhere in here?". If there is, its
# directory is unknowable and we ask; if there is not (`bash -c 'ls -la'`), the
# command stays silent rather than becoming noise.
if [ "$non_lease_force" -eq 0 ] && [ "$targets_protected" -eq 0 ] && \
   [ "$unresolved_ctx" -eq 0 ] && [ "$opaque_ctx" -eq 1 ]; then
  if git_ctx_has_invocation "$(printf '%s' "$command_str" | sed "s/[\"']//g")" git push; then
    unresolved_ctx=1
  fi
fi

# No gated condition and a confidently-resolved context → silent pass.
if [ "$non_lease_force" -eq 0 ] && [ "$targets_protected" -eq 0 ] && [ "$unresolved_ctx" -eq 0 ]; then
  exit 0
fi

# Escape hatch — hook env or inline assignment.
if [ "${GIT_TOOLING_ALLOW_FORCE_PUSH:-0}" = "1" ] || [ "$inline_escape" -eq 1 ]; then
  exit 0
fi

if [ "$non_lease_force" -eq 1 ]; then
  headline="About to **force-push without a lease** (\`--force\` / \`-f\` / a \`+refspec\`)."
  detail="A non-lease \`--force\` overwrites the remote unconditionally — it can clobber commits a teammate (or another session) pushed since you last fetched. \`--force-with-lease\` refuses if the remote moved; prefer it.

Per the project push policy, any non-lease force-push is gated regardless of branch."
elif [ "$targets_protected" -eq 0 ]; then
  headline="Could not determine which repo/branch this \`git push\` targets."
  detail="The command changes directory (or points \`git -C\` somewhere) in a way this guard cannot resolve, so it cannot tell whether the push lands on the default branch. Rather than let a possible direct-to-main push through unchecked, it is asking.

Check the target branch yourself before approving."
else
  headline="About to push to a **protected / default branch**."
  detail="Direct pushes (and force-pushes) to the default branch are gated per the project push policy — this repo follows a worktree → branch → PR flow. Push a feature branch and open a PR instead."
fi

reason="${headline}

${detail}

If this is intentional, approve the prompt. To skip this check for one command:
  GIT_TOOLING_ALLOW_FORCE_PUSH=1 <your command>"

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $reason
  }
}'
exit 0
