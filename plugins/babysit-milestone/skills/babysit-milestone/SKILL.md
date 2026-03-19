---
name: babysit-milestone
description: "Orchestrate GitHub milestone deployment end-to-end. Discover autonomous issues, spawn parallel agents on worktrees, monitor PRs, fix CI/review failures, rebase on merge, clean up. Triggers: \"babysit milestone\", \"deploy milestone\", \"work through milestone\", \"milestone deployment\"."
allowed-tools:
  - Bash(gh issue list*)
  - Bash(gh issue view*)
  - Bash(gh pr create*)
  - Bash(gh pr list*)
  - Bash(gh pr view*)
  - Bash(gh pr checks*)
  - Bash(gh api*)
  - Bash(gh repo view*)
  - Bash(git worktree*)
  - Bash(git pull*)
  - Bash(git checkout*)
  - Bash(git branch*)
  - Bash(git rebase*)
  - Bash(git push*)
  - Read
  - Agent
  - Skill
example_prompts:
  - "babysit milestone 3"
  - "deploy milestone 5"
  - "work through milestone 2"
---

# Babysit Milestone

Orchestrate a GitHub milestone deployment end-to-end: discover issues, categorize by autonomy, spawn parallel agents on worktrees, monitor PRs, fix CI and review failures, rebase after merges, and clean up.

## Current Repository (Injected)

**Repository:**
```
!`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "(not in a git repo)"`
```

## Arguments

`$ARGUMENTS` = the milestone number (e.g., `3`)

If no milestone number is provided, ask the user which milestone to target. List available milestones with:

```bash
gh api repos/{owner}/{repo}/milestones --jq '.[] | "\(.number) - \(.title) (\(.open_issues) open issues)"'
```

---

## Phase 1: Discovery & Planning

### 1.1 Fetch milestone issues

```bash
gh issue list --milestone "$ARGUMENTS" --state open --json number,title,labels,body,assignees
```

### 1.2 Categorize issues

Group issues by **autonomy level** based on labels:

| Label | Category | Meaning |
|-------|----------|---------|
| `autonomous` | Autonomous | Can be implemented without human input |
| `semi-autonomous` | Semi-Autonomous | Needs brief clarification, then can proceed |
| `requires-direction` | Needs Direction | Requires human design decisions |
| *(none of the above)* | Uncategorized | Default to semi-autonomous |

Also group by **epic** — look for labels prefixed with `epic:` or `epic/`.

### 1.3 Present findings to user

Display a summary table:

```
## Milestone {N}: {title}

### Autonomous ({count})
- #{num}: {title}
- #{num}: {title}

### Semi-Autonomous ({count})
- #{num}: {title} — needs: {brief note on what's unclear}

### Needs Direction ({count})
- #{num}: {title} — needs: {what decisions are required}

### Uncategorized ({count})
- #{num}: {title}
```

### 1.4 Get user approval

Ask the user:
- Which autonomous issues to launch (default: all)
- Whether any semi-autonomous issues are clear enough to launch
- Whether to skip any issues

**Do NOT proceed to Phase 2 until the user confirms.**

---

## Phase 2: Parallel Implementation

For each approved issue, execute these steps:

### 2.1 Prepare the workspace

```bash
git pull origin main
```

### 2.2 Create worktree

Derive a branch name from the issue title (lowercase, hyphens, max 50 chars). Prefix with issue number.

```bash
git worktree add worktrees/{issue_num}-{branch-name} -b {issue_num}-{branch-name}
```

**IMPORTANT**: Worktrees go in `worktrees/<branch>/` at the repo root. NEVER use `.claude/worktrees/`.

### 2.3 Spawn implementation agent

For each issue, spawn a background Agent. **NEVER use `isolation: "worktree"` on the Agent tool.** Instead, instruct the agent to work in the worktree directory.

Use `run_in_background: true` on the Agent tool call.

The agent prompt should include:

```
You are implementing GitHub issue #{number}: {title}

## Issue Body
{full issue body from gh issue view}

## Instructions

1. Work ONLY in this directory: {absolute_path_to_worktree}
2. Read the issue carefully and implement the requested changes
3. Run all tests and linting to ensure everything passes
4. Commit your changes with a descriptive message referencing the issue:
   git commit -m "feat: {description}

   Closes #{number}"
5. Push the branch:
   git push -u origin {branch-name}
6. Create a PR with the milestone set:
   gh pr create --title "{pr_title}" --body "{pr_body}" --milestone "{milestone_number}"
7. Report the PR number when done

Repository: {owner/repo}
Working directory: {absolute_path_to_worktree}
```

### 2.4 Track spawned agents

Maintain a mental ledger of:

| Issue | Branch | Worktree Path | Agent Status | PR Number |
|-------|--------|---------------|--------------|-----------|
| #123  | 123-add-feature | worktrees/123-add-feature | spawned | — |

Report the table to the user after all agents are spawned.

---

## Phase 3: Monitoring Setup

### 3.1 Collect PR numbers

As agents complete and report PR numbers, collect them. You can also poll:

```bash
gh pr list --json number,title,headRefName --jq '.[] | select(.headRefName | startswith("{issue_num}-"))'
```

### 3.2 Set up PR monitoring loop

Once PRs exist, invoke the `pr-checker` skill to check their status:

```
/loop 2m check PR status: /pr-checker {pr_numbers}
```

Update the loop as new PRs are created.

---

## Phase 4: Continuous Maintenance

This phase is **reactive** — respond to events as they occur from monitoring or user reports.

### 4.1 CI Failure

When a PR has failing checks:

1. Get failure details:
   ```bash
   gh pr checks {pr_number}
   ```
2. Get the failing log:
   ```bash
   gh run view {run_id} --log-failed
   ```
3. Spawn a fix agent in the **existing worktree** for that branch:
   ```
   Agent(run_in_background: true):
   "Fix CI failure on PR #{pr_number} in {worktree_path}.
    Failing check: {check_name}
    Error: {error_summary}
    Work in: {absolute_worktree_path}
    After fixing, commit, push, and report back."
   ```

### 4.2 Review Threads

When a PR has unresolved review threads:

1. Fetch unresolved threads:
   ```bash
   gh api graphql -f query='
   {
     repository(owner: "{owner}", name: "{repo}") {
       pullRequest(number: {pr_number}) {
         reviewThreads(first: 100) {
           nodes {
             id
             isResolved
             comments(first: 5) {
               nodes { path line body author { login } }
             }
           }
         }
       }
     }
   }' | jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
   ```

2. Spawn a fix agent in the existing worktree:
   ```
   Agent(run_in_background: true):
   "Address review comments on PR #{pr_number} in {worktree_path}.

    Review threads to address:
    {thread_details}

    Instructions:
    1. Fix each issue in {absolute_worktree_path}
    2. Commit and push
    3. Resolve each thread via GraphQL:
       gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "{id}"}) { thread { isResolved } } }'
    4. Report what was fixed"
   ```

### 4.3 PR Merged

When a PR merges:

1. Update the tracking table to mark it merged
2. Pull latest main:
   ```bash
   git pull origin main
   ```
3. Check if remaining branches need rebasing:
   ```bash
   git -C worktrees/{branch} rebase main
   ```
   If rebase conflicts occur, spawn a fix agent to resolve them.
4. Clean up the merged branch's worktree:
   ```bash
   git worktree remove worktrees/{branch}
   git branch -d {branch}
   ```

### 4.4 All PRs Merged

When every issue in the milestone has a merged PR:

1. Clean up all remaining worktrees:
   ```bash
   git worktree list
   git worktree remove worktrees/{branch}  # for each
   git worktree prune
   ```
2. Verify milestone completion:
   ```bash
   gh issue list --milestone "$ARGUMENTS" --state open --json number,title
   ```
3. Report final status to user:
   ```
   ## Milestone {N} Complete

   | Issue | PR | Status |
   |-------|-----|--------|
   | #123 | #456 | Merged |
   | #124 | #457 | Merged |

   All worktrees cleaned up. {N} issues resolved.
   ```

---

## Error Handling

- **Agent fails to create PR**: Check the worktree for uncommitted changes, diagnose the error, spawn a new agent to complete the work
- **Worktree creation fails**: Branch may already exist — check with `git branch --list` and `git worktree list`
- **Rebase conflicts**: Spawn a fix agent with conflict details; never force-push without user approval
- **Rate limiting**: If GitHub API rate limits hit, pause and retry after the reset window

## Important Rules

1. **Never use `isolation: "worktree"` on Agent tool** — it creates worktrees in `.claude/worktrees/` which causes nesting issues
2. **Always use `run_in_background: true`** for implementation and fix agents
3. **Worktrees live at `worktrees/<branch>/`** from the repo root
4. **Each agent works in its own worktree** — no two agents should modify the same worktree simultaneously
5. **Pull main before creating new worktrees** to minimize merge conflicts
6. **Never force-push** without explicit user approval
7. **Clean up worktrees** after PRs merge — don't leave stale worktrees
