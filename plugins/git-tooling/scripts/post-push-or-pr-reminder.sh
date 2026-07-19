#!/usr/bin/env bash
# post-push-or-pr-reminder.sh - PostToolUse(Bash) hook for git-tooling.
#
# Reads the hook event JSON from stdin and emits additionalContext when:
#   * `git push` actually pushed a branch that already has an open PR, OR
#   * `gh pr create` actually opened a PR.
#
# Either trigger nudges the agent to refresh the PR title/description if the
# pushed scope changed and to invoke the `ci-watch` skill to monitor CI.
#
# IDENTITY COMES FROM THE COMMAND'S OWN OUTPUT, NEVER FROM THE WORKING DIR.
# ------------------------------------------------------------------------
# An earlier version resolved "which branch" by cd-ing to the payload `cwd` and
# reading `git symbolic-ref --short HEAD`. That silently reports the wrong
# branch whenever the command ran somewhere other than the session cwd (e.g.
# `cd other-worktree && git push`), or whenever the session cwd is a worktree
# checked out to a different branch than the one being pushed. The hook then
# named an unrelated open PR and told the agent to `gh pr edit` it — which
# would have overwritten that PR's title and body. A wrong read-only suggestion
# costs a minute; a wrong mutating suggestion destroys someone's work.
#
# So: the pushed branch is parsed from git's own `<src> -> <dst>` ref-update
# lines, and a created PR's number and repo are parsed from the URL that
# `gh pr create` printed. If neither can be established with confidence, the
# hook stays silent rather than guessing.
#
# Stays silent (exit 0, no output) for any Bash call that is not one of those
# triggers, so the hook is safe to attach to all Bash invocations.

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

# Classify the command by PARSING it, not by substring-matching it. Substring
# matching let read-only commands fire this hook: `rg 'git push' docs/` and
# `gh pr comment 114 --body 'use gh pr create next time'` both contain the
# trigger phrase as data, and both emit output that the parsers below would
# otherwise read as a push ref block or a created-PR URL.
trigger=""
if git_ctx_has_invocation "$command_str" gh pr create; then
  trigger="pr_create"
elif git_ctx_has_invocation "$command_str" git push; then
  trigger="push"
else
  exit 0
fi

# github_slug_from_remote <remote>
#
# Normalizes a GitHub remote — either git's `To <remote>` line or a local
# `git remote get-url` value — to `owner/repo`. Accepts both forms git prints:
# `git@github.com:owner/repo.git` (colon) and `https://github.com/owner/repo`
# (slash), with an optional `.git` suffix. Prints nothing and returns 1 for
# anything that is not a GitHub remote, so callers can treat "unparseable" and
# "not GitHub" identically.
#
# Shared by the two sites that need a slug — the pushed-to remote and the local
# checkout's `origin` — because those two are only comparable if they are
# normalized the same way.
github_slug_from_remote() {
  local remote="$1" path owner repo
  case "$remote" in
    *github.com[:/]*) ;;
    *) return 1 ;;
  esac
  path="${remote##*github.com}"
  path="${path#:}"
  path="${path#/}"
  path="${path%.git}"
  owner="${path%%/*}"
  # `owner == path` means there was no `/` at all — not an owner/repo pair.
  [ -n "$owner" ] && [ "$owner" != "$path" ] || return 1
  repo="${path#*/}"
  repo="${repo%%/*}"
  [ -n "$repo" ] || return 1
  printf '%s/%s' "$owner" "$repo"
}

# window_has_dry_run <binary> <sub1> [sub2]
#
# Returns 0 when the `<binary> [flags] <sub1> [sub2]` invocation carries a
# dry-run flag IN ITS OWN ARGUMENT WINDOW — the tokens between the subcommand
# and the shell separator that ends that command. Same window force-push-guard
# parses for force-ness.
#
# Scoping matters: an earlier version scanned every token in the command
# string, so `git push 2>&1 | head -n 20` was read as a dry run and the
# reminder was silently dropped for a push that really did reach the remote.
# The `-n` there is head's. A flag only means "dry run" if it belongs to the
# push.
window_has_dry_run() {
  local binary="$1" sub1="$2" sub2="${3:-}"
  local glob_was_off i j n prev_is_sep tok matched
  local -a toks

  # Tokenize with globbing disabled — an unquoted `*` in the command string
  # would otherwise expand against the cwd. Save/restore -f rather than using a
  # subshell, which would trip `set -e` on a non-zero exit.
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
  # Command-word position, so a literal `git` that is an ARGUMENT (`echo git
  # push -n`) is not mistaken for an invocation.
  prev_is_sep=1
  while [ "$i" -lt "$n" ]; do
    tok="${toks[$i]:-}"
    if [ "$tok" = "$binary" ] && [ "$prev_is_sep" -eq 1 ]; then
      # Skip binary-level flags, including the ones that consume a value.
      j=$((i + 1))
      while [ "$j" -lt "$n" ]; do
        case "${toks[$j]:-}" in
          -C|-c|-R|--repo) j=$((j + 2)) ;;
          --git-dir=*|--work-tree=*|--namespace=*|-*) j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      matched=0
      if [ "${toks[$j]:-}" = "$sub1" ]; then
        j=$((j + 1))
        if [ -z "$sub2" ]; then
          matched=1
        else
          # Flags may sit between the two subcommand words (`gh pr -R x create`).
          while [ "$j" -lt "$n" ]; do
            case "${toks[$j]:-}" in
              -R|--repo) j=$((j + 2)) ;;
              -*) j=$((j + 1)) ;;
              *) break ;;
            esac
          done
          if [ "${toks[$j]:-}" = "$sub2" ]; then
            matched=1
            j=$((j + 1))
          fi
        fi
      fi
      if [ "$matched" -eq 1 ]; then
        while [ "$j" -lt "$n" ]; do
          case "${toks[$j]:-}" in
            # A separator ends this command's window; anything past it is a
            # different command's flags.
            "&&"|"||"|"|"|";"|"|&"|";;") break ;;
            *";") break ;;
            --dry-run) return 0 ;;
            --*) ;;
            # `-n` is the short form, and may appear in a cluster (`-vn`).
            -*n*) return 0 ;;
          esac
          j=$((j + 1))
        done
        return 1
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

# A dry run prints ref-update lines byte-identical to a real push (and
# `gh pr create --dry-run` prints a PR-shaped preview), so output parsing
# cannot tell them apart. Nothing reached the remote — nothing to say.
if [ "$trigger" = "pr_create" ]; then
  if window_has_dry_run gh pr create; then exit 0; fi
else
  if window_has_dry_run git push; then exit 0; fi
fi

# The command's own stdout/stderr is the only trustworthy source of identity.
# The exact shape varies by Claude Code version, so accept the documented
# object form as well as the plain-string and array forms.
tool_output="$(printf '%s' "$payload" | jq -r '
  (.tool_response // .tool_result // null) as $r
  | if $r == null then ""
    elif ($r | type) == "string" then $r
    elif ($r | type) == "object" then
      ([$r.stdout, $r.stderr, $r.output, $r.content]
       | map(if type == "string" then . else "" end) | join("\n"))
    elif ($r | type) == "array" then
      ($r | map(if type == "object" then ((.text // .content // "") | tostring)
                else (. | tostring) end) | join("\n"))
    else ""
    end
' 2>/dev/null || true)"

# No output means we cannot confirm what actually happened. Fail safe.
[ -z "$tool_output" ] && exit 0

command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

# Resolve the directory the command actually ran in, for the (purely cosmetic)
# commit listing. Shared with the guards so all three hooks agree on what "the
# directory this command runs in" means. Best-effort context only — this is
# never allowed to determine which PR we name, so an unresolvable directory
# just costs us the commit listing rather than being an error.
payload_cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
work_dir="$(git_ctx_resolve_dir "$payload_cwd" "$command_str" || true)"
if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
  cd "$work_dir" || exit 0
fi

# repo_slug is owner/repo when we can establish it from the command output.
# Empty means "unknown": every gh call and every suggested command then omits
# -R, and we never claim to know which repo the PR lives in.
repo_slug=""
branch=""
pr_number=""

if [ "$trigger" = "pr_create" ]; then
  # `gh pr create` prints the URL of the PR it just created. That URL *is* the
  # PR — no lookup, no inference, no dependence on the working directory.
  # The URL must occupy a WHOLE LINE. `gh pr create` prints exactly that; a
  # substring match instead accepts `.../pull/114#issuecomment-999` from
  # `gh pr comment` (truncating to PR 114) and any URL merely quoted in prose.
  pr_url_from_output="$(printf '%s\n' "$tool_output" \
    | sed 's/[[:space:]]*$//' \
    | grep -xE 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+' \
    | tail -1 || true)"
  [ -z "$pr_url_from_output" ] && exit 0

  pr_number="${pr_url_from_output##*/pull/}"
  slug_path="${pr_url_from_output#https://github.com/}"
  repo_slug="${slug_path%%/pull/*}"
else
  # Parse git's ref-update block. Real forms (all on stderr):
  #   To github.com:owner/repo.git
  #    * [new branch]      feat/x -> feat/x
  #      abc1234..def5678  feat/x -> feat/x
  #    + abc1234...def5678 feat/x -> feat/x (forced update)
  #    - [deleted]         feat/x            <- no "->", correctly ignored
  # "Everything up-to-date" produces no ref lines at all, so we stay silent.
  #
  # The right-hand side is the REMOTE ref, which is what a PR's head points at
  # (`git push origin HEAD:feat/x` prints `HEAD -> feat/x`; feat/x is correct).
  # A real push always prints a `To <remote>` line followed by its ref-update
  # block. Requiring EXACTLY ONE such line is the anchor that makes this
  # parser safe: without it, any output that merely contains `a -> b` (a
  # ripgrep hit in a design doc, a commit subject) looked like a push. Zero
  # `To` lines means nothing was pushed; more than one means several pushes
  # were chained and we cannot attribute the branch to a single repo.
  #
  # Trailing whitespace is stripped here: git and server output routinely
  # carry it, and it would otherwise defeat the `.git` suffix strip below.
  remote_lines="$(printf '%s\n' "$tool_output" \
    | sed -n 's/^To[[:space:]]\{1,\}\(.*[^[:space:]]\)[[:space:]]*$/\1/p' \
    | sort -u || true)"
  remote_count="$(printf '%s\n' "$remote_lines" | grep -c . || true)"
  [ "$remote_count" = "1" ] || exit 0
  remote_line="$remote_lines"

  # Parse refs only from the block AFTER the `To` line, and drop:
  #   `remote:` — server-side text (GitHub's "Create a pull request" banner,
  #               pre-receive hook output), not ref updates
  #   `!`       — REJECTED updates. These carry a `->` and previously read as
  #               success, so a rejected push claimed it had landed.
  ref_lines="$(printf '%s\n' "$tool_output" \
    | sed -n '/^To[[:space:]]/,$p' \
    | grep -v '^[[:space:]]*remote:' \
    | grep -v '^[[:space:]]*!' || true)"

  pushed_refs="$(printf '%s\n' "$ref_lines" \
    | sed -n 's/.*[[:space:]]->[[:space:]]\{1,\}\([^[:space:]()]\{1,\}\).*/\1/p' \
    | sed 's|^refs/heads/||' \
    | grep -v '^$' | sort -u || true)"

  ref_count="$(printf '%s\n' "$pushed_refs" | grep -c . || true)"
  # Exactly one pushed branch, or we cannot say which PR is meant.
  [ "$ref_count" = "1" ] || exit 0
  branch="$pushed_refs"
  repo_slug="$(github_slug_from_remote "$remote_line" || true)"

  if [ -n "$repo_slug" ]; then
    pr_json="$(gh pr list --head "$branch" --state open -R "$repo_slug" --json number,title,url,headRefName --limit 1 2>/dev/null || echo '[]')"
  else
    pr_json="$(gh pr list --head "$branch" --state open --json number,title,url,headRefName --limit 1 2>/dev/null || echo '[]')"
  fi

  # `jq length` succeeds on objects and strings too, so assert the array shape
  # before trusting it — a gh error object would otherwise read as a result.
  if [ "$(printf '%s' "$pr_json" | jq -r 'type' 2>/dev/null || echo none)" != "array" ]; then
    exit 0
  fi
  pr_count="$(printf '%s' "$pr_json" | jq 'length' 2>/dev/null || echo 0)"
  [ "$pr_count" = "0" ] && exit 0

  # Belt and braces: the PR we are about to name must actually be headed by the
  # branch that was pushed. If gh ever returns something else, stay silent.
  pr_head="$(printf '%s' "$pr_json" | jq -r '.[0].headRefName // empty')"
  [ "$pr_head" = "$branch" ] || exit 0

  pr_number="$(printf '%s' "$pr_json" | jq -r '.[0].number')"
  pr_title="$(printf '%s' "$pr_json" | jq -r '.[0].title // empty')"
  pr_url="$(printf '%s' "$pr_json" | jq -r '.[0].url // empty')"
fi

[ -z "$pr_number" ] && exit 0

# For pr_create we know the number and repo but not yet the display fields.
# A failed lookup is not fatal — the number came from the command's output, so
# fall back to a title-less message rather than going silent.
if [ "$trigger" = "pr_create" ]; then
  pr_view="$(gh pr view "$pr_number" -R "$repo_slug" --json title,url,headRefName 2>/dev/null || echo '{}')"
  pr_title="$(printf '%s' "$pr_view" | jq -r '.title // empty' 2>/dev/null || true)"
  pr_url="$(printf '%s' "$pr_view" | jq -r '.url // empty' 2>/dev/null || true)"
  branch="$(printf '%s' "$pr_view" | jq -r '.headRefName // empty' 2>/dev/null || true)"
  [ -z "$pr_url" ] && pr_url="$pr_url_from_output"
fi

# -R on every suggested command so the agent cannot act on the right number in
# the wrong repo.
repo_flag=""
[ -n "$repo_slug" ] && repo_flag=" -R ${repo_slug}"

title_suffix=""
[ -n "$pr_title" ] && title_suffix=": \"${pr_title}\""

if [ "$trigger" = "pr_create" ]; then
  lead_line="Just opened PR #${pr_number}${title_suffix}"
  [ -n "$branch" ] && lead_line="Just opened PR #${pr_number} from branch \`${branch}\`${title_suffix}"
else
  lead_line="Just pushed branch \`${branch}\` which has open PR #${pr_number}${title_suffix}"
fi
[ -n "$pr_url" ] && lead_line="${lead_line}
${pr_url}"

# Commit context is best-effort. Two things must both hold before we print it:
#
#   1. the checkout we are standing in is the SAME REPO the push output named,
#      and
#   2. that checkout genuinely contains the branch we are talking about.
#
# (2) alone is not enough. The directory here is whatever the command happened
# to run in; it is not evidence of repo identity. Branch names like `main`,
# `dev`, or a shared convention repeat across repos, so a same-named branch in
# a DIFFERENT checkout satisfied (2) and got ITS commits listed under this
# repo's PR number — reproduced end to end. Comparing the local `origin` slug
# against the slug parsed from the push output is what ties the listing to the
# right repo.
#
# When either slug is unknown (no `origin`, a non-GitHub remote, an
# unattributable push) we omit the listing. It is cosmetic, so dropping it
# costs nothing; printing the wrong repo's commits is actively misleading.
commits_block=""
local_origin_slug=""
if [ -n "$repo_slug" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  local_origin_slug="$(github_slug_from_remote \
    "$(git remote get-url origin 2>/dev/null || true)" || true)"
fi
if [ -n "$branch" ] && [ -n "$local_origin_slug" ] && [ "$local_origin_slug" = "$repo_slug" ]; then
  if git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null 2>&1; then
    default_base="$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
    [ -z "$default_base" ] && default_base="main"
    recent_commits="$(git log --oneline "origin/${default_base}..refs/heads/${branch}" 2>/dev/null | head -10 || true)"
    if [ -n "$recent_commits" ]; then
      commits_block="
Recent commits on this branch:
${recent_commits}
"
    fi
  fi
fi

# Stated as observations, not instructions, and READ-ONLY throughout. The
# property that holds is not "emits no runnable command" — `gh pr checks <n>`
# below is deliberately runnable, because it answers a question the agent
# otherwise has to guess at. The property is that every command this hook can
# emit, on either trigger path, only READS: no mutating verb (`gh pr edit` /
# `merge` / `close` / `ready`) appears anywhere in the output.
#
# That is the line worth holding. A pre-filled mutating command line
# (`gh pr edit <n> --body ...`) is one bad inference away from overwriting a PR
# body nobody asked to change, and hook context that reads as an out-of-band
# instruction can trip prompt-injection defenses besides. Report what was
# observed and let the agent decide what to do about it; the facts below are
# enough to act on.
reminder="${lead_line}
${commits_block}
The PR's title and body were written before this push and may no longer describe the whole branch — an earlier push can already have made them stale.

CI for PR #${pr_number} is not currently being watched. The \`ci-watch\` skill watches a PR through to a terminal state in the background, including on one-line, config, version-bump, and docs PRs: the shared review/CI workflow runs on most PRs regardless of which files changed. \`gh pr checks ${pr_number}${repo_flag}\` reports whether this PR has any checks at all."

jq -n --arg ctx "$reminder" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ctx
  }
}'
