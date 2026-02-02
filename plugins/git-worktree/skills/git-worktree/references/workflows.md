# Advanced Worktree Workflows

## Bare Repository Setup

For maximum worktree efficiency, clone as a bare repo and use worktrees exclusively:

```bash
git clone --bare git@github.com:user/repo.git repo.git
cd repo.git
git worktree add worktrees/main main
git worktree add worktrees/feature-x feature-x
```

This avoids having a "default" checkout and treats all branches equally.

### Adjusting fetch for bare repos

Bare repos don't fetch all remote branches by default. Configure:

```bash
git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git fetch --all
```

## CI Integration Pattern

Create worktrees in CI for parallel test execution:

```bash
# Create worktrees for the PR branch and base branch
git worktree add worktrees/pr-branch "$PR_BRANCH"
git worktree add worktrees/base-branch "$BASE_BRANCH"

# Run tests in parallel
cd worktrees/pr-branch && npm test &
cd worktrees/base-branch && npm test &
wait
```

## Worktree with Submodules

When the repository uses submodules, initialize them in each worktree:

```bash
git worktree add worktrees/feature feature-branch
cd worktrees/feature
git submodule update --init --recursive
```

## Handling Detached HEAD Worktrees

Worktrees can be created at a specific commit without a branch:

```bash
git worktree add --detach worktrees/release-audit v2.1.0
```

Useful for auditing tagged releases while continuing development.

## Worktree Locking

Lock a worktree to prevent accidental removal (e.g., on a network drive):

```bash
git worktree lock worktrees/important-feature
git worktree lock --reason "Long-running experiment" worktrees/experiment
```

Unlock when done:

```bash
git worktree unlock worktrees/important-feature
```

## Recovering from Broken Worktrees

If a worktree directory is manually deleted without `git worktree remove`:

```bash
# Prune stale worktree entries
git worktree prune

# Verify cleanup
git worktree list
```

If the worktree was on an external drive that's been disconnected, lock it instead of pruning:

```bash
git worktree lock --reason "External drive disconnected" worktrees/external
```

## Multiple Remotes

When working with forks and upstream remotes:

```bash
# Add upstream
git remote add upstream git@github.com:original/repo.git
git fetch upstream

# Create worktree tracking upstream branch
git worktree add worktrees/upstream-main upstream/main
```

## Worktree Naming Strategies

### By PR number

```
worktrees/pr-123/
worktrees/pr-456/
```

### By feature area

```
worktrees/auth-login/
worktrees/auth-signup/
worktrees/api-v2/
```

### By developer

```
worktrees/alice-feature/
worktrees/bob-bugfix/
```

Choose a naming convention and apply it consistently. The skill defaults to sanitized branch names (slashes replaced with hyphens).

## Cleaning Up After Merge

Full cleanup workflow after a PR is merged:

```bash
# Switch to main and pull
git switch main
git pull

# Remove the worktree
git worktree remove worktrees/feature-branch

# Delete the local branch
git branch -d feature-branch

# Prune any stale entries
git worktree prune

# Clean up remote tracking branches
git fetch --prune
```

## Troubleshooting

### "fatal: is already checked out"

A branch can only be checked out in one worktree at a time. To find where:

```bash
git worktree list | grep branch-name
```

Either remove that worktree or use a different branch.

### Worktree shows wrong branch

If a worktree is in detached HEAD state unexpectedly:

```bash
cd worktrees/feature
git switch feature-branch
```

### Permission denied on worktree removal

If files are locked by another process (IDE, file watcher):

1. Close the IDE/process using files in that worktree
2. Retry `git worktree remove`
3. If still failing, use `git worktree remove --force` (after confirming no important changes)
