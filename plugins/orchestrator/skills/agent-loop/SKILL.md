---
name: agent-loop
description: 'Continuous autonomous milestone execution: plan once, then dispatch agents,
  monitor PRs, fix reviews, and advance work without stopping. Triggers: "orchestrate",
  "manage PRs", "milestone", "dispatch agents", "parallel implementation", "wave",
  "pipeline", "monitor PRs", "coordinate work", "run the pipeline", "implement milestone",
  "babysit PRs".


  <example>

  Context: User asks to implement a milestone with multiple issues

  user: "Implement the v0.16.0 milestone — 8 issues across kova and home-orchestration"

  assistant: "I''ll orchestrate this milestone. Let me analyze the issues, identify
  dependencies, and create tasks with blockedBy relationships. Then I execute continuously
  until everything is merged — dispatching each issue the moment its blockers clear."

  <commentary>

  Skill activates for milestone-scale coordination. Agent groups issues into waves only
  to organize TaskCreate calls and set blockedBy dependencies. After planning, execution
  is entirely dependency-driven — each task starts when its blockers are done, not when
  a named wave completes.

  </commentary>

  </example>


  <example>

  Context: A PR merges, unblocking downstream tasks

  assistant: "PR #101 merged. #104 was blocked by #101 — dispatching agent for #104
  now. PR #102 is still in review; #105 will start when it merges."

  <commentary>

  After planning, waves are irrelevant. The orchestrator reacts to individual PR merges:
  mark task done, call TaskList to find newly unblocked tasks, dispatch agents for them
  immediately. No wave announcements, no waiting for a whole group to finish.

  </commentary>

  </example>


  <example>

  Context: Reviews came in on open PRs

  assistant: "Reviewer flagged 3 issues on PR #45 and 1 doc gap on PR #46. Fix agents
  dispatched for both. I''ll resolve the threads once fixes land."

  <commentary>

  Orchestrator reacts to review feedback by immediately dispatching fix agents. It does
  not report findings and wait — it acts and reports what it did.

  </commentary>

  </example>


  '
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
example_prompts:
  - "orchestrate the v0.16.0 milestone"
  - "implement these 6 issues in parallel"
  - "manage my open PRs"
  - "start the pipeline for this milestone"
  - "dispatch agents for unblocked issues"
  - "babysit the open PRs until they merge"
---

# Agent Loop

Continuously execute a milestone: plan once, get approval, then run autonomously until every issue has a merged PR or the user stops you.

## Core Principle

**Plan, then execute.** Build the wave plan, present it for visibility, then start immediately. Do not ask for approval to begin — just begin. Maintain a constant stream of work. Never idle. Never ask "should I continue?" — just continue.

---

## Phase 1: Plan (The ONE Time You Ask)

This phase happens once at session start. Be thorough but fast.

### Gather the Work

```bash
# List milestone issues
gh issue list --repo OWNER/REPO --milestone "MILESTONE" --state open --json number,title,labels,assignees,body

# Or fetch specific issues
gh issue view NUMBER --repo OWNER/REPO --json title,body,labels
```

### Identify Dependencies

Read each issue body and labels. Look for:
- Explicit "blocked by" or "depends on" references
- Shared files that would cause merge conflicts (check file paths)
- Logical ordering (API before UI, schema before queries)
- Cross-repo dependencies (K8s manifest depends on service code)

### Organize into Waves (Planning Convenience Only)

Group issues so everything within a group can run in parallel. This grouping exists only to organize your `TaskCreate` calls and set `blockedBy` dependencies — it has no role in execution.

```
Wave 1 (parallel): #101, #102, #103  — independent foundation work
Wave 2 (parallel): #104, #105        — depends on wave 1
Wave 3 (sequential): #106            — depends on wave 2
```

**Wave rules:**
- Issues touching the same files go in different waves
- Cross-repo issues are usually parallelizable
- When in doubt, serialize — a blocked agent wastes more time than a short wait

> **Waves are a planning convenience for setting up `blockedBy` dependencies. After tasks are created, waves are irrelevant — execution is purely dependency-driven.** Each task starts the moment its own blockers are done, regardless of what else is still running in the same "wave."

### Build the Plan and Execute

Use TaskCreate to formalize the plan — **one task per GitHub issue, not one task for the whole milestone**:

- Each task subject must include the issue number and title: `"#101: Add streaming support [kova-land/kova]"`
- Set `blockedBy` dependencies between tasks that mirror the wave grouping above
- Mark tasks `done` as their PRs merge (not when the PR is opened)

```
TaskCreate: "#101: <title> [kova-land/kova]"          → no blockers
TaskCreate: "#102: <title> [kova-land/kova]"          → no blockers
TaskCreate: "#103: <title> [jedwards1230/home-orchestration]"  → no blockers
TaskCreate: "#104: <title>" blockedBy=#101            → blocked until #101 merges
TaskCreate: "#105: <title>" blockedBy=#102            → blocked until #102 merges
TaskCreate: "#106: <title>" blockedBy=#104,#105       → blocked until both merge
```

Present the plan for visibility, then dispatch all tasks with no blockers in the same response. Do not ask "Ready to start?" — just start.

---

## Phase 2: Execute (Continuous, Autonomous)

After approval, the loop begins. It does not stop until the milestone is done.

### Dispatch Implementation Agents

For each issue in the current wave:

1. Create a worktree: `git worktree add worktrees/<branch-name> -b <branch-name>`
   - Use `worktrees/<branch>/` from the repo root — NOT `.claude/worktrees/`
2. Spawn a Task agent with `run_in_background`:

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
- Do NOT modify <shared files that other agents touch>
- Run tests before committing: <test command>
- Run linter before committing: <lint command>
- Create a PR when done: gh pr create --title "<type>: <description>" --body "Closes OWNER/REPO#N"
```

3. Use TaskUpdate to mark the issue `in_progress`

**Dispatch ALL wave agents simultaneously.** Do not wait for one to finish before starting the next.

### Start Monitoring Immediately

After dispatching agents, start a cron to track CI and reviews:

```
CronCreate: "pr-monitor" interval=5m
  ${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh
```

Or use the built-in checker:
```
/loop 5m /pr-checker
```

**Every push gets a cron.** No exceptions.

### The Core Loop

This runs continuously after wave dispatch:

```
WHILE milestone has open issues:
  1. Check agent completion status
  2. Check CI status on all open PRs (all repos)
  3. Check review status on all open PRs
  4. For each completed agent: verify PR was created, start monitoring
  5. For each CI failure: dispatch fix agent immediately
  6. For each review with findings: dispatch fix agent for ALL findings immediately
  7. For each PR with reviewer approval + CI green: add to merge-ready queue
  8. For each merged PR: mark task done → call TaskList → dispatch agents for any task whose blockedBy are now all done
  9. Do not wait for a group to finish — each task starts the moment its own blockers clear
  10. TaskUpdate with current status
```

**Do not break out of this loop to ask questions.** If you need user input, use AskUserQuestion and keep the loop running.

---

## Phase 3: React (Immediately, Always)

### CI Failures

| Status | Action |
|--------|--------|
| PASSING | Add to merge-ready announcement |
| FAILING | Read the failure log. Dispatch a fix agent into the same worktree. Do not report and wait. |
| IN PROGRESS | Continue to next PR |
| MERGE CONFLICT | Rebase the branch, force-push, re-monitor |

### Review Feedback

When reviews arrive:

1. Read ALL review comments — body, inline comments, and suggestion blocks
2. Dispatch a fix agent immediately for ALL findings. Do not cherry-pick.
3. After the fix agent pushes, resolve threads via GraphQL:

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

# Resolve after fix is pushed
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}'
```

4. Re-run `/pr-checker` to verify CI still passes after fixes

**Goal: reviewer all-clear on every PR.** `codecov/patch` failures alone are acceptable. Reviewer findings are not.

**Stale reviews:** If a review is >24h old with no response after fixes, note it in your status update but do not re-dump the full review body.

### Merge Readiness

When a PR has CI green + reviewer approval:
- Announce it with the recommended merge order (dependencies first)
- Use AskUserQuestion with the merge list and a "merge all in this order?" option
- **Never merge without explicit user approval**
- While waiting for merge approval, keep working on everything else

---

## Phase 4: Advance (Without Asking)

### Dependency-Driven Execution

After planning, **waves no longer exist.** Execution is driven entirely by the `blockedBy` relationships in your task list. Apply this rule on every PR merge:

> **PR merges → mark task done → call TaskList → any task whose blockedBy list is now all done is ready → dispatch its agent NOW, in this response.**

That is the entire loop. There is no "wave 2 starts" — there is only "task X is no longer blocked."

When a PR merges:

1. Use TaskUpdate to mark the completed task as `done`
2. Call TaskList and look for any task whose every `blockedBy` entry is now `done`
3. For each newly-unblocked task: rebase its branch onto updated main, dispatch its agent immediately
4. Start monitoring the new PRs
5. Report what you did in the same response: "PR #101 merged → #104 unblocked → dispatching agent for #104 now."

Do not wait for a group of PRs to all merge before acting. Each task starts the moment its own blockers clear, regardless of what else is still running.

**The wrong pattern:**
```
"Wave 1 is complete. Wave 2 consists of #104 and #105. Ready to start wave 2?"
```

**The right pattern:**
```
"PR #101 merged → #104 unblocked → dispatching agent for #104 now.
PR #102 is still in review; #105 will start when it merges."
```

### Cross-Repo Coordination

- Run `/pr-checker` against EVERY repo with open PRs, not just the current one
- Track which repo each PR belongs to in your task list
- Dependencies can span repos — merge the upstream repo's PR first

```bash
# Check all repos
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R kova-land/kova
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/home-orchestration
${CLAUDE_PLUGIN_ROOT}/scripts/prci.sh -R jedwards1230/claude-plugins
```

---

## Phase 5: Complete (Milestone-Driven Termination)

The loop runs until one of:
- **All milestone issues have merged PRs** — propose closing the milestone and tagging the release
- **The user stops it** — clean up worktrees, summarize remaining work

### When All Issues Are Done

```
All 6 issues merged. Milestone v0.16.0 is complete.

Merged PRs:
- kova-land/kova#201: <title>
- kova-land/kova#202: <title>
- jedwards1230/home-orchestration#45: <title>
...

Recommend: close milestone and tag v0.16.0 release. Proceed?
```

### When Blocked

If you need user input (via AskUserQuestion) and get no response for >1 monitoring cycle:
- Remind them what's waiting: "Blocked on: merge approval for PRs #201, #202. Everything else is done."
- Keep monitoring other PRs — do not stop the loop just because one question is pending

---

## When to Ask vs When to Act

### ACT without asking:
- Dispatch agents for unblocked issues
- Fix reviewer feedback (dispatch fix agents)
- Fix CI failures
- Rebase branches with conflicts
- Resolve review threads after fixes land
- Start monitoring crons after every push
- Dispatch newly-unblocked tasks after merges
- Create follow-up issues for out-of-scope findings

### ASK using AskUserQuestion:
- Merge approval (always — provide the merge order and a recommendation)
- Architectural decisions with real tradeoffs (present 2-3 options with pros/cons)
- Scope changes ("Issue #105 is larger than expected — defer to next milestone?")
- Ambiguous requirements that code can't resolve
- Milestone closure and release tagging

**When asking, be specific.** Use AskUserQuestion with concrete options and your recommendation. Do not bury questions in output text — grab the user's attention.

---

## PR Hygiene

**Keep PR titles and descriptions current.** After pushing significant fixes or adding features to a PR, update the title and body via `gh pr edit` to reflect the current state. Reviewers and the user should be able to understand the PR's scope from the title alone.

```bash
gh pr edit <number> --title "new title" --body "updated description"
```

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| Report review findings and wait | Dispatch fix agents immediately |
| Think in waves during execution | Use TaskList blockedBy as the execution engine |
| "Wave 1 complete, starting wave 2" | "PR merged → task done → unblocked tasks dispatched" |
| Ask "should I start wave 2?" | Dispatch the next task the moment its blockers merge |
| Wait for all of wave 1 to merge before starting any wave 2 issue | Start each task the moment its own blockers clear |
| One TaskCreate for the whole milestone | One TaskCreate per GitHub issue with blockedBy dependencies |
| "Wave 1 complete. Here's wave 2. Ready?" | "PR #101 merged → #104 unblocked → dispatching #104 now." |
| Check one repo at a time | Check all repos in parallel |
| Wait for user to notice CI failure | Fix it, report what you did |
| Push PRs without monitoring | Start a cron after every push |
| Serialize independent issues | Organize into parallel groups when planning |
| Use `.claude/worktrees/` | Use `worktrees/<branch>/` from repo root |
| Merge without asking | Announce readiness, get explicit approval |
| Stop the loop to ask a question | Use AskUserQuestion and keep working |
| Re-dump stale review text | Note it, move on |

## Safety Rails

**Never do proactively:**
- Merge PRs without explicit user approval
- Force-push to main/master
- Start work that contradicts user's stated plan
- Close issues or milestones without approval
- Run destructive git operations on main (reset --hard, clean -f)

**Always do proactively:**
- Dispatch fix agents for every review finding
- Start monitoring crons after every push
- Dispatch newly-unblocked tasks when blockers merge
- Rebase branches when conflicts appear
- Flag cross-PR failure patterns
- Remind the user when their input is blocking progress

## Quick Reference

| Phase | Action | Tool |
|-------|--------|------|
| Plan | Analyze issues, find dependencies | `gh issue list/view` |
| Plan | Organize waves, present plan | TaskCreate, output to user |
| Plan | Get approval (ONE time) | Wait for user response |
| Execute | Create worktrees | `git worktree add` |
| Execute | Spawn parallel agents | Agent with `run_in_background` |
| Execute | Track progress | TaskUpdate |
| Monitor | Track CI and reviews | CronCreate / `/loop 5m /pr-checker` |
| React | Fix CI failures | Dispatch fix agent |
| React | Fix review findings | Dispatch fix agent |
| React | Resolve review threads | `gh api graphql` |
| Advance | Merge (with approval) | AskUserQuestion, then `gh pr merge` |
| Advance | Dispatch unblocked tasks (no asking) | TaskList → dispatch agents |
| Complete | Close milestone | AskUserQuestion, then `gh api` |
