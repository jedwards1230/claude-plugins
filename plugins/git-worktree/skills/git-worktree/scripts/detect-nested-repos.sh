#!/usr/bin/env bash
#
# detect-nested-repos.sh - Discover independent git repos nested inside the current repo
#
# Scans services/ and tooling/ directories for .git dirs that indicate
# independent repos (cloned via init-repos.sh, NOT submodules/subtrees).
#
# Output: One line per nested repo with path, remote, branch, and worktree count.
# If no nested repos found, outputs "(none detected)".
#
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$root" ]; then
  echo "(not in a git repo)"
  exit 0
fi

found=0

# Scan known directories for nested .git repos
for search_dir in "$root/services" "$root/tooling"; do
  [ -d "$search_dir" ] || continue

  while IFS= read -r gitdir; do
    dir=$(dirname "$gitdir")
    rel=${dir#"$root"/}
    branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "detached")
    remote=$(git -C "$dir" remote get-url origin 2>/dev/null || echo "no remote")
    wt_count=$(git -C "$dir" worktree list 2>/dev/null | wc -l | tr -d ' ')

    # Get existing worktree details if more than just the main tree
    wt_info=""
    if [ "$wt_count" -gt 1 ]; then
      wt_info=" | worktree dirs:"
      while IFS= read -r wt_line; do
        wt_path=$(echo "$wt_line" | awk '{print $1}')
        wt_branch=$(echo "$wt_line" | sed 's/.*\[//;s/\].*//')
        # Skip the main working tree
        [ "$wt_path" = "$dir" ] && continue
        wt_rel=${wt_path#"$root"/}
        wt_info="$wt_info $wt_rel[$wt_branch]"
      done <<< "$(git -C "$dir" worktree list 2>/dev/null)"
    fi

    echo "  $rel (branch: $branch, remote: $remote, worktrees: $wt_count)$wt_info"
    found=1
  done < <(find "$search_dir" -maxdepth 3 -name .git -type d 2>/dev/null | sort)
done

if [ "$found" -eq 0 ]; then
  echo "(none detected)"
fi
