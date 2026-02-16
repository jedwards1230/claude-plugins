---
name: git-worktree
description: This skill should be used when the user asks to "create a worktree",
  "add a worktree", "set up worktrees for PRs", "create worktrees for open pull requests",
  "inspect worktrees", "show worktree status", "clean up worktrees", "prune worktrees",
  "list worktrees", "remove stale worktrees", "new branch worktree", "parallel branch
  development", or mentions git worktree management. Provides workflows for creating,
  managing, and cleaning up git worktrees for efficient parallel branch development.
  Assume the user does NOT want to commit and push directly to main — always create
  a worktree on a feature branch so changes go through a PR.
allowed-tools:
- Read
- Glob
- Grep
- Bash(git worktree:*)
- Bash(git branch:*)
- Bash(git switch:*)
- Bash(git symbolic-ref:*)
- Bash(git status:*)
- Bash(git diff:*)
- Bash(git log:*)
- Bash(git fetch:*)
- Bash(git remote:*)
- Bash(git rev-parse:*)
- Bash(gh pr:*)
- Bash(gh auth:*)
- Bash(gh repo:*)
- Bash(mkdir:*)
- Bash(ls:*)
- Bash(pwd:*)
- Bash(basename:*)
- Bash(wc:*)
- Bash(cd:*)
- Bash(cat:*)
- Bash(*/worktree-audit.sh:*)
- AskUserQuestion
example_prompts:
- create worktrees for all open PRs
- set up a new worktree for this branch
- clean up stale worktrees
- list my worktrees
- create a worktree for a new feature branch
- prune merged worktree branches
permalink: tooling/claude-plugins/plugins/git-worktree/skills/git-worktree/skill
---

# Git Worktree Management

Manage git worktrees for parallel branch development. Worktrees allow working on multiple branches simultaneously without stashing or switching, each in its own directory.

## Current Repository State (Injected)

**Repository root:**
```
!`git rev-parse --show-toplevel 2>/dev/null`
```

**Current branch:**
```
!`git branch --show-current 2>/dev/null`
```

**Existing worktrees:**
```
!`git worktree list 2>/dev/null`
```

**Remote tracking:**
```
!`git remote get-url origin 2>/dev/null`
```

**Nested repositories (independent git repos inside this repo):**
```
!`ls -d services/*/.git tooling/*/.git 2>/dev/null`
```

## Nested Repository Handling

**CRITICAL**: If nested repositories are detected above, you MUST determine which repo the user wants the worktree in BEFORE creating it. Nested repos are independent git repositories with their own branches, remotes, and worktrees. They are NOT tracked by the parent repo (they are gitignored).

**Rules:**
1. If the user's request names or implies a nested repo (e.g., "create a worktree for home-agent"), the worktree MUST be created inside that nested repo's directory, not the parent.
2. If ambiguous, use AskUserQuestion to ask which repo: the parent or one of the nested repos.
3. When creating a worktree in a nested repo, `cd` into that repo first. All git commands (fetch, branch, worktree add) must run from the nested repo's root.
4. Worktree paths for nested repos follow the same convention: `<nested-repo>/worktrees/<branch-name>/`.
5. Never create a parent-repo worktree expecting nested repo code to appear in it — the nested repos are gitignored and won't be present in the worktree.
6. For PRs (Workflow 1), check the remote URL to determine which GitHub repo to query with `gh pr list`.
7. Commits for changes in a nested repo must be made from within that repo, not from the parent.

**Example — creating a worktree in a nested repo:**
```bash
cd services/home-agent
git fetch origin
git worktree add -b feat/my-feature worktrees/feat-my-feature origin/main
# Work in: services/home-agent/worktrees/feat-my-feature/
```

## Worktree Directory Convention

All worktrees are created under a `worktrees/` directory at the repository root:

```
<repo-root>/
├── worktrees/
│   ├── <branch-1>/     # Worktree for branch-1
│   ├── <branch-2>/     # Worktree for branch-2
│   └── feature-xyz/    # Worktree for feature-xyz
├── src/                 # Main working tree
└── ...
```

Branch names containing slashes (e.g., `feature/login`) are flattened to use hyphens (e.g., `feature-login`) for directory names.

Ensure `worktrees/` is added to `.gitignore` to avoid committing worktree directories.

## Workflows

Analyze the user's request and determine which workflow to execute. If unclear, ask using AskUserQuestion.

### Workflow 1: Create Worktrees for Open PRs

Fetch all open pull requests from GitHub and create a worktree for each.

**Steps:**

1. Verify GitHub CLI authentication: `gh auth status`
   - If not authenticated, prompt the user to run `gh auth login` and stop
2. Ensure worktrees directory exists: `mkdir -p worktrees`
3. Check `.gitignore` for `worktrees/` entry; add it if missing
4. Fetch remote branches: `git fetch --all --prune`
5. List open PRs: `gh pr list --state open --json number,headRefName,title`
   - If no open PRs found, report and stop
6. List existing worktrees: `git worktree list` to determine what to skip
7. For each PR branch:
   - Sanitize the branch name for directory use (replace `/` with `-`)
   - Skip if a worktree already exists for that branch
   - Create worktree: `git worktree add worktrees/<sanitized-name> <branch-name>`
   - If the branch does not exist locally, track it from origin: `git worktree add worktrees/<sanitized-name> -b <branch-name> origin/<branch-name>`
8. Report results with the summary table format

**Error handling:**
- If `gh` is not authenticated, prompt the user to run `gh auth login`
- If a branch has been force-pushed or its ref is missing, skip it and report
- If `git worktree add` fails for a specific branch, log the error and continue with remaining branches

### Workflow 2: Create a New Branch and Worktree

Interactively create a new branch with a worktree for feature development.

**Steps:**

1. Ask the user for the branch name (if not provided) using AskUserQuestion
2. Validate the branch name:
   - No spaces or special characters beyond `/`, `-`, `_`, `.`
   - Check local branches: `git branch --list <name>` — must not exist
   - Check remote branches: `git branch -r --list origin/<name>` — must not exist
   - If the name is taken, suggest alternatives or ask for a new name
3. Determine the base commit:
   - Default: the repository's default branch (usually `main` or `master`)
   - Detect default branch: `git rev-parse --abbrev-ref origin/HEAD`
   - If the user specifies a different base (tag, branch, commit SHA), use that instead
4. Ensure the worktrees directory exists and is in `.gitignore`
5. Sanitize branch name for directory use (replace `/` with `-`)
6. Fetch latest state: `git fetch origin`
7. Create worktree with new branch: `git worktree add -b <branch-name> worktrees/<dir-name> <base>`
8. Verify the worktree was created: `git worktree list`
9. Report the full path to the new worktree directory

**Error handling:**
- If `git fetch origin` fails (network error), warn the user and offer to proceed with local state
- If the base ref does not exist, list available branches/tags and ask the user to pick one
- If `git worktree add` fails (permissions, disk space), report the error message and suggest remediation

### Workflow 3: Clean Up Stale Worktrees

Remove worktrees for branches that have been merged or deleted.

**Quick audit**: Run `worktree-audit.sh` (in `scripts/` directory of this plugin) first to get a structured report across all repos, including squash-merge detection via GitHub PRs. Use `--no-gh` for offline mode, `--no-fetch` to skip fetching. Then use the report to decide which worktrees to remove below.

**Steps:**

1. Fetch latest remote state: `git fetch --all --prune`
2. List all worktrees: `git worktree list --porcelain`
3. Identify the main working tree (first entry) — this is never removed
4. For each non-main worktree:
   - Extract the branch name from the worktree entry
   - Check if merged: `git branch --merged main` (or the default branch)
   - Check if remote-deleted: `git branch -r --list origin/<branch>` — empty means deleted
   - Check for uncommitted changes: `git -C <worktree-path> status --porcelain`
   - Check if locked: `git worktree lock` status in porcelain output
   - Categorize as: stale (merged + no changes), orphaned (remote-deleted), active, or dirty
5. Present findings to the user using AskUserQuestion:
   - List stale and orphaned worktrees with their status
   - Flag any with uncommitted changes as requiring explicit confirmation
   - Allow the user to select which to remove
6. For confirmed removals:
   - Remove worktree: `git worktree remove worktrees/<name>`
   - Delete the local branch if merged: `git branch -d <branch-name>`
   - If branch is not merged and user confirms: `git branch -D <branch-name>`
7. Run `git worktree prune` to clean up stale administrative entries
8. Report the summary table of actions taken

**Safety rules:**
- Never force-remove a worktree with uncommitted changes without explicit user approval
- Always present the full list before taking any destructive action
- Preserve the main working tree unconditionally
- Never remove a locked worktree without asking — explain why it is locked

### Workflow 4: List and Inspect Worktrees

Display the current worktree state with useful context.

**Steps:**

1. Run `git worktree list --porcelain` for machine-readable output
2. For each worktree, gather additional context:
   - Branch name: extracted from the `branch` line in porcelain output
   - Last commit: `git -C <worktree-path> log -1 --oneline`
   - Ahead/behind upstream: `git -C <worktree-path> rev-list --left-right --count @{upstream}...HEAD 2>/dev/null`
   - Uncommitted changes: `git -C <worktree-path> status --porcelain | wc -l`
   - Locked status: check for `locked` line in porcelain output
3. Present as a formatted summary table with columns: Directory, Branch, Last Commit, Ahead/Behind, Dirty, Locked
4. Highlight any worktrees with uncommitted changes or that are significantly behind upstream

**Error handling:**
- If a worktree directory is missing but still tracked by git, flag it as broken and suggest running `git worktree prune`
- If a branch has no upstream tracking, show "no upstream" in the Ahead/Behind column instead of failing

## Important Notes

- **Always fetch first**: Run `git fetch --all --prune` before PR-based operations to ensure branch data is current.
- **gitignore**: Ensure `worktrees/` is in `.gitignore`. Check and add it if missing.
- **Bare repos**: If the repository is a bare clone, worktrees are the primary way to work. Adjust paths accordingly.
- **Locked worktrees**: If a worktree is locked (`git worktree lock`), do not remove it without asking.
- **Nested repos**: See "Nested Repository Handling" section above. Always check which repo the user intends before creating worktrees. Never create a parent-repo worktree for nested-repo work.

## Output Summary

After completing any workflow, provide a summary:

```
**Worktree Summary**

| Action | Branch | Directory | Status |
|--------|--------|-----------|--------|
| Created | feature-login | worktrees/feature-login | Ready |
| Skipped | bugfix-typo | worktrees/bugfix-typo | Already exists |
| Removed | old-feature | worktrees/old-feature | Merged into main |

Total worktrees: X active
```

## Additional Resources

For detailed worktree workflow patterns and troubleshooting:
- **`references/workflows.md`** - Advanced worktree patterns, bare repo setup, CI integration