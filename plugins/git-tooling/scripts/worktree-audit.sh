#!/usr/bin/env bash
# worktree-audit.sh - Audit git worktrees across a root repo and nested repos
#
# Usage: worktree-audit.sh [--root <path>] [--no-gh] [--no-fetch]
#   --root <path>   Override root repo (default: git rev-parse --show-toplevel)
#   --no-gh         Skip GitHub PR checks for squash-merge detection (faster/offline)
#   --no-fetch      Skip git fetch --all --prune (use cached state)
set -euo pipefail

ROOT="" NO_GH=false NO_FETCH=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "Error: --root requires a path argument" >&2; exit 1
      fi
      ROOT="$2"; shift 2 ;;
    --no-gh) NO_GH=true; shift ;;
    --no-fetch) NO_FETCH=true; shift ;; *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$ROOT" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not in a git repo" >&2; exit 1; }
fi
if ! git -C "$ROOT" rev-parse --git-dir &>/dev/null; then
  echo "Error: --root must point to a valid git repository: $ROOT" >&2; exit 1
fi

GH_AVAILABLE=true
if [[ "$NO_GH" == false ]] && ! gh auth status &>/dev/null; then
  echo "Warning: gh not authenticated, skipping PR squash-merge checks" >&2
  GH_AVAILABLE=false
fi

# Global summary arrays
SUMMARY_REPOS=() SUMMARY_ACTIVE=() SUMMARY_STALE=()
SUMMARY_STALE_DIRTY=() SUMMARY_ORPHANED=() SUMMARY_TOTAL=()

discover_repos() {
  local repos=("$ROOT")
  for dir in services tooling; do
    [[ -d "$ROOT/$dir" ]] || continue
    while IFS= read -r g; do repos+=("$(dirname "$g")"); done \
      < <(find "$ROOT/$dir" -maxdepth 2 -name .git -type d 2>/dev/null)
  done
  printf '%s\n' "${repos[@]}"
}

fetch_all() {
  for repo in "$@"; do git -C "$repo" fetch --all --prune &>/dev/null & done; wait
}

parse_github_remote() {
  local url; url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  echo "$url" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s/\.git$//'
}

get_default_branch() {
  local ref; ref="$(git -C "$1" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)" || true
  [[ -n "$ref" ]] && echo "${ref#refs/remotes/origin/}" || echo "main"
}

classify_worktree() { # args: git_merged squash_merged remote_exists dirty
  local merged=false
  [[ "$1" == "yes" || "$2" == "yes" ]] && merged=true
  if $merged && [[ "$4" -eq 0 ]]; then echo "STALE"
  elif $merged && [[ "$4" -gt 0 ]]; then echo "STALE-DIRTY"
  elif [[ "$3" == "no" && "$1" == "no" && "$2" != "yes" ]]; then echo "ORPHANED"
  else echo "ACTIVE"; fi
}

audit_repo() {
  local repo="$1" repo_name; repo_name="$(basename "$repo")"
  local default_branch; default_branch="$(get_default_branch "$repo")"
  local porcelain; porcelain="$(git -C "$repo" worktree list --porcelain 2>/dev/null)" || return

  # Parse porcelain: collect non-main worktree paths and branches
  local wt_paths=() wt_branches=() detached_notes=()
  local path="" branch="" first=true
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) [[ -n "$path" && "$first" == false ]] && { wt_paths+=("$path"); wt_branches+=("$branch"); }
        path="${line#worktree }"; branch="" ;;
      "branch "*) branch="${line#branch refs/heads/}" ;;
      "detached") [[ "$first" == false ]] && { detached_notes+=("$path"); path=""; branch=""; } ;;
      "") if [[ -n "$path" && "$first" == false ]]; then wt_paths+=("$path"); wt_branches+=("$branch")
          elif [[ -n "$path" ]]; then first=false; fi; path="" branch="" ;;
    esac
  done <<< "$porcelain"
  [[ -n "$path" && "$first" == false ]] && { wt_paths+=("$path"); wt_branches+=("$branch"); }

  local count=${#wt_paths[@]}; [[ $count -eq 0 ]] && return

  for dp in "${detached_notes[@]}"; do
    echo "<!-- Skipped detached HEAD worktree: $(realpath --relative-to="$repo" "$dp" 2>/dev/null || echo "$dp") -->"
  done

  local gh_remote=""
  [[ "$NO_GH" == false && "$GH_AVAILABLE" == true ]] && gh_remote="$(parse_github_remote "$repo" 2>/dev/null)" || true
  local merged_branches; merged_branches="$(git -C "$repo" branch --merged "$default_branch" 2>/dev/null | sed 's/^[* ]*//')" || true

  local label="worktrees"; [[ $count -eq 1 ]] && label="worktree"
  echo "### $repo_name ($count $label)"
  echo ""
  echo "| Status | Branch | Directory | Remote | Merged | Dirty | Last Commit |"
  echo "|--------|--------|-----------|--------|--------|-------|-------------|"

  local active=0 stale=0 stale_dirty=0 orphaned=0
  for i in "${!wt_paths[@]}"; do
    local wt="${wt_paths[$i]}" br="${wt_branches[$i]}"
    [[ -z "$br" ]] && continue

    local remote_exists="no" git_merged="no" squash_merged="no" merged_display="no"
    [[ -n "$(git -C "$repo" branch -r --list "origin/$br" 2>/dev/null)" ]] && remote_exists="yes"
    echo "$merged_branches" | grep -Fqx "$br" 2>/dev/null && git_merged="yes"

    if [[ "$git_merged" == "yes" ]]; then merged_display="git"
    elif [[ "$NO_GH" == false && "$GH_AVAILABLE" == true && -n "$gh_remote" ]]; then
      local pr; pr="$(gh pr list --repo "$gh_remote" --state merged --head "$br" --json headRefName --limit 1 2>/dev/null)" || true
      [[ -n "$pr" && "$pr" != "[]" ]] && { squash_merged="yes"; merged_display="squash"; }
    elif [[ "$git_merged" == "no" && ( "$NO_GH" == true || "$GH_AVAILABLE" == false ) ]]; then merged_display="skip"; fi

    local dirty=0; dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l)"; dirty="${dirty// /}"
    local commit; commit="$(git -C "$wt" log -1 --format="%h %s" 2>/dev/null)" || commit="(no commits)"
    [[ ${#commit} -gt 58 ]] && commit="${commit:0:58}..."
    local rel; rel="$(realpath --relative-to="$repo" "$wt" 2>/dev/null || echo "$wt")"
    local status; status="$(classify_worktree "$git_merged" "$squash_merged" "$remote_exists" "$dirty")"

    case "$status" in
      ACTIVE) ((active++)) || true ;; STALE) ((stale++)) || true ;;
      STALE-DIRTY) ((stale_dirty++)) || true ;; ORPHANED) ((orphaned++)) || true ;;
    esac
    echo "| $status | $br | $rel | $remote_exists | $merged_display | $dirty | $commit |"
  done
  echo ""

  SUMMARY_REPOS+=("$repo_name"); SUMMARY_ACTIVE+=("$active"); SUMMARY_STALE+=("$stale")
  SUMMARY_STALE_DIRTY+=("$stale_dirty"); SUMMARY_ORPHANED+=("$orphaned"); SUMMARY_TOTAL+=("$count")
}

print_summary() {
  [[ ${#SUMMARY_REPOS[@]} -eq 0 ]] && return
  local ta=0 ts=0 tsd=0 to=0 tt=0
  echo "### Summary"
  echo ""
  echo "| Repo | Active | Stale | Stale-Dirty | Orphaned | Total |"
  echo "|------|--------|-------|-------------|----------|-------|"
  for i in "${!SUMMARY_REPOS[@]}"; do
    echo "| ${SUMMARY_REPOS[$i]} | ${SUMMARY_ACTIVE[$i]} | ${SUMMARY_STALE[$i]} | ${SUMMARY_STALE_DIRTY[$i]} | ${SUMMARY_ORPHANED[$i]} | ${SUMMARY_TOTAL[$i]} |"
    ((ta+=SUMMARY_ACTIVE[$i])) || true; ((ts+=SUMMARY_STALE[$i])) || true
    ((tsd+=SUMMARY_STALE_DIRTY[$i])) || true; ((to+=SUMMARY_ORPHANED[$i])) || true
    ((tt+=SUMMARY_TOTAL[$i])) || true
  done
  echo "| **Total** | **$ta** | **$ts** | **$tsd** | **$to** | **$tt** |"
  echo ""
}

main() {
  mapfile -t repos < <(discover_repos)
  [[ "$NO_FETCH" == false ]] && fetch_all "${repos[@]}"
  echo "## Worktree Audit -- $(date +%Y-%m-%d)"
  echo ""
  for repo in "${repos[@]}"; do audit_repo "$repo"; done
  print_summary
  if [[ ${#SUMMARY_REPOS[@]} -eq 0 ]]; then
    echo "No non-main worktrees found across ${#repos[@]} repositories."
    echo ""
  fi
}

main
