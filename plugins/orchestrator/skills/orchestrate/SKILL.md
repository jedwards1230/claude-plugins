---
name: orchestrate
description: 'Multi-repo PR lifecycle management, milestone orchestration, wave-based
  parallel implementation, and proactive pipeline management. Triggers: "orchestrate",
  "manage PRs", "milestone", "dispatch agents", "parallel implementation", "wave",
  "pipeline", "monitor PRs", "coordinate work", "run the pipeline", "implement milestone",
  "start wave", "babysit PRs".


  <example>

  Context: User asks to implement a milestone with multiple issues

  user: "Implement the v0.16.0 milestone — 8 issues across kova and home-orchestration"

  assistant: "I''ll orchestrate this milestone. Let me analyze the issues, identify
  dependencies, organize into waves, and start dispatching implementation agents."

  <commentary>

  Skill activates for milestone-scale coordination. Agent plans waves, creates worktrees,
  dispatches parallel agents, and monitors the full PR lifecycle.

  </commentary>

  </example>


  <example>

  Context: Agent has pushed PRs and needs to monitor them

  assistant: "All 4 PRs are pushed. Starting monitoring loop to track CI status and
  reviews across all repos."

  <commentary>

  After pushing, the orchestrator starts a /loop to monitor CI and review status,
  and reacts to results without waiting for user nudges.

  </commentary>

  </example>


  <example>

  Context: Reviews came in on open PRs

  assistant: "Reviewer flagged 3 issues on PR #45 and 1 doc gap on PR #46. Dispatching
  fix agents for both PRs now."

  <commentary>

  Orchestrator reacts to review feedback by immediately dispatching fix agents — does
  not just report findings.

  </commentary>

  </example>

  '
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh*)
  - Bash(gh pr *)
  - Bash(gh issue *)
  - Bash(gh api *)
  - Bash(gh repo *)
  - Bash(git worktree *)
  - Bash(git branch *)
  - Bash(git checkout *)
  - Bash(git push *)
  - Read
  - Glob
  - Grep
example_prompts:
  - "orchestrate the v0.16.0 milestone"
  - "implement these 6 issues in parallel"
  - "manage my open PRs"
  - "start the pipeline for this milestone"
  - "dispatch agents for wave 2"
  - "babysit the open PRs until they merge"
---

# Orchestrator

Coordinate multi-issue milestones across repos: plan waves, dispatch parallel agents, monitor PR lifecycle, react to reviews, and keep the pipeline moving without idle time.

## Mindset

You are the conductor, not the performer. Your job is to:
1. **Plan** what work can run in parallel
2. **Dispatch** agents to do the work
3. **Monitor** CI and reviews continuously
4. **React** to results immediately — fix failures, address reviews, announce readiness
5. **Advance** the pipeline as soon as work unblocks

**Never idle.** If you are waiting for something, check if anything else can be started. If everything is in flight, start a monitoring loop.

## Phase 1: Analyze and Plan

### Gather the Work

```bash
# List milestone issues
gh issue list --repo OWNER/REPO --milestone "MILESTONE" --state open --json number,title,labels,assignees

# Or list specific issues
gh issue view NUMBER --repo OWNER/REPO --json title,body,labels
```

### Identify Dependencies

Read each issue's body and labels. Look for:
- Explicit "blocked by" or "depends on" references
- Shared files that would cause merge conflicts
- Logical ordering (API before UI, schema before queries)

### Organize into Waves

Group issues into waves where each wave contains issues that can run in parallel (no file conflicts, no dependencies within the wave).

```
Wave 1 (parallel): #101, #102, #103  — independent foundation work
Wave 2 (parallel): #104, #105        — depends on wave 1
Wave 3 (sequential): #106            — depends on wave 2
```

**Rules for wave planning:**
- Issues touching the same files MUST be in different waves
- Cross-repo issues are usually parallelizable (different repos = no conflicts)
- Within a repo, check for overlapping file paths before parallelizing
- Smaller waves are better than blocked agents — when in doubt, serialize

### Create Task Tracking

Use TaskCreate to track the overall milestone and individual issues:

```
TaskCreate: "Milestone v0.16.0 — 6 issues, 3 waves"
  - Wave 1: #101 (in_progress), #102 (in_progress), #103 (in_progress)
  - Wave 2: #104 (pending), #105 (pending)
  - Wave 3: #106 (pending)
```

## Phase 2: Dispatch Implementation Agents

### Worktree Convention

Every feature branch gets its own worktree:

```bash
# In the target repo
git worktree add worktrees/<branch-name> -b <branch-name>
```

Use `worktrees/<branch>/` from the repo root — NOT `.claude/worktrees/`.

### Spawn Agents

For each issue in the current wave, spawn a Task agent with:
1. **Clear deliverable**: "Implement issue #N: <title>"
2. **Working directory**: The worktree path
3. **Context**: Issue body, acceptance criteria, relevant file paths
4. **Constraints**: Which files to touch, which to avoid

Use `run_in_background` for all implementation agents so they run in parallel.

### Agent Spawn Template

```
Implement issue OWNER/REPO#N: <title>

Working directory: /path/to/repo/worktrees/<branch>/

## Issue
<paste issue body>

## Acceptance Criteria
<paste from issue>

## Files to modify
- path/to/file1.go
- path/to/file2.go

## Constraints
- Do NOT modify <shared files>
- Run tests before committing: <test command>
- Run linter before committing: <lint command>
- Create a PR when done with: gh pr create --title "<type>: <description>" --body "Closes OWNER/REPO#N"
```

## Phase 3: Monitor and React

### Start Monitoring Loop

After pushing PRs, immediately start a monitoring loop using the built-in PR checker:

```
/loop 5m /pr-checker
```

Or run it directly:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh
```

This checks CI status and review threads across all repos with open PRs.

### When to Start Loops
- **After pushing any PR**: Start `/loop 5m /pr-checker` immediately
- **After dispatching agents**: Start `/loop 2m check agent status` to track completion
- **During review cycles**: Keep the loop running until all PRs are merged or session ends

### When to Stop Loops
- All PRs in the current scope are merged
- Session is ending
- User explicitly asks to stop

### React to CI Results

| CI Status | Action |
|-----------|--------|
| ALL PASSING | Announce "PR #N is green and ready for review/merge" |
| FAILING | Read the failure, dispatch a fix agent immediately |
| IN PROGRESS | Wait for next loop iteration |
| HAS MERGE CONFLICTS | Rebase the branch, push force if needed |

### React to Reviews

When reviews come in:

1. **Read ALL review comments** — not just threads, check the review body too
2. **Categorize findings**: code issues, docs gaps, nits, questions
3. **Dispatch fix agents immediately** for ALL findings — do not just report them
4. **After fixes are pushed**: Re-run `/pr-checker` to verify
5. **Resolve threads** via GraphQL after fixes are pushed and verified

```bash
# Get unresolved threads
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUM) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { path line body }
          }
        }
      }
    }
  }
}' | jq -r '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'

# Resolve a thread after fixing
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}'
```

### Goal: Reviewer All-Clear

Keep iterating fixes until the reviewer gives LGTM with no issues. `codecov/patch` failures alone are acceptable, but reviewer findings must be addressed.

## Phase 4: Advance the Pipeline

### Merge Ordering

When PRs are ready to merge:

1. **Identify dependencies** — merge foundation PRs first
2. **Check for conflicts** — if PR B depends on PR A, merge A first and rebase B
3. **Announce readiness** — tell the user which PRs are ready and in what order
4. **Never merge without user approval** — announce and wait

```
PRs ready to merge (recommended order):
1. PR #101 — foundation refactor (no dependencies)
2. PR #102 — API changes (no dependencies)
3. PR #103 — depends on #101, rebase needed after #101 merges
```

### Unblock Next Waves

When a wave's PRs merge:

1. **Immediately start the next wave** — don't wait for the user to say "start wave 2"
2. **Rebase dependent branches** if needed
3. **Update task tracking** — mark completed, start in-progress

### Cross-Repo Awareness

When working across multiple repos:
- Run `/pr-checker` against every repo with open PRs, not just the current one
- Track which repo each PR belongs to
- Dependencies can span repos — a K8s manifest PR might depend on a service code PR

```bash
# Check all repos with open PRs
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R kova-land/kova
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/home-orchestration
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/claude-plugins
```

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| Report review findings and wait | Dispatch fix agents immediately |
| Ask "should I start wave 2?" | Start wave 2 as soon as wave 1 merges |
| Check one repo at a time | Check all repos with open PRs in parallel |
| Wait for user to notice CI failure | Fix it and report what you did |
| Create PRs without monitoring | Always start a `/loop` after pushing |
| Serialize independent issues | Organize into parallel waves |
| Use `.claude/worktrees/` | Use `worktrees/<branch>/` from repo root |
| Merge PRs without asking | Announce readiness, wait for approval |

## Safety Rails

**Never do proactively:**
- Merge PRs without explicit user approval
- Force-push to main/master
- Start work that contradicts user's stated plan
- Close issues without user approval
- Run destructive git operations (reset --hard, clean -f)

**Always do proactively:**
- Start monitoring loops after pushing
- Dispatch fix agents for review feedback
- Announce when PRs are ready to merge
- Start next wave when current wave merges
- Flag patterns of failures across PRs
- Rebase branches when conflicts are detected

## Quick Reference

| Phase | Key Action | Tool |
|-------|-----------|------|
| Plan | Analyze issues, find dependencies | `gh issue list/view` |
| Plan | Organize waves | TaskCreate |
| Dispatch | Create worktrees | `git worktree add` |
| Dispatch | Spawn agents | Task agent with `run_in_background` |
| Monitor | Track CI/reviews | `/loop 5m /pr-checker` |
| React | Fix review findings | Dispatch fix agents |
| React | Fix CI failures | Dispatch fix agents |
| Advance | Announce merge readiness | Report to user |
| Advance | Start next wave | Dispatch new agents |
