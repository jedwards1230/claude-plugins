---
name: orchestrate
description: >-
  Delegate a task — or several — into an ownership hierarchy of agents. The
  decision isn't whether to delegate but how to shape the tree: one task → spawn
  ONE owner agent that runs it end-to-end and
  orchestrates its own subagents below it (explore → implement → verify). Many
  tasks → spawn one owner per task, in parallel, each managing its own subtree.
  Agents nest up to 5 levels deep. This is ad-hoc delegation via the built-in
  Agent tool — not the Workflow tool's deterministic loops, not agent teams'
  cross-talk. Triggers: "orchestrate this", "orchestrate
  these tasks", "fan out agents", "use subagents", "spawn agents in parallel",
  "delegate this", "run agents on this", "coordinate subagents", "nest agents".


  <example>

  Context: A single substantial task the user wants delegated.

  user: "Orchestrate this: add the new metrics endpoint and wire it into the dashboard."

  assistant: "Spawning one owner agent (the plugin's `owner` type) that owns the
  whole task. It'll orchestrate its own subagents — one to explore the existing
  endpoints, one to implement, one to verify — and hand me back the result."

  <commentary>

  One task → one owner at depth 1, who re-delegates downward. The owner owns the
  outcome; I own the owner.

  </commentary>

  </example>


  <example>

  Context: Several independent tasks to run at once.

  user: "Orchestrate these four: bump the chart, fix the flaky test, write the
  changelog, and audit the auth flow."

  assistant: "Four owner agents in parallel, one per task. Each owns its task and
  spawns whatever subagents it needs underneath. I collect four digests."

  <commentary>

  N tasks → N owners at depth 1, each managing its own subtree independently.

  </commentary>

  </example>
argument-hint: "[--model opus|sonnet|haiku] <task, or several>"
---

# Orchestrate

Orchestration means handing work to a hierarchy of agents rather than doing it
yourself. The decision isn't *whether* to delegate — it's how to shape the tree
and what context to pack into each spawn. Set up the ownership hierarchy, spawn
it, then synthesize what comes back.

## Ready to orchestrate?

Delegation amplifies whatever you hand it — including unsettled scope. Before
shaping the tree, check:

- **Was there a real design discussion**, or are you about to delegate an idea
  that hasn't been thought through? Unsettled decisions become thrown-away PRs.
- **Do you know what *complete* looks like?** A missing acceptance bar (e.g.
  "must support both backends, not just one") is the best predictor of review
  churn and mid-flight rework.
- **Do you know where new artifacts live** — which repo, package, plugin, doc?
  Building in the wrong place is the most expensive guess an owner can make.
- **Any open questions?** Ask the user now, before spawning — not mid-flight.

A terse invocation is fine when the conversation already answered these; a
detailed brief can't save a task whose decisions are still open.

## The model: every task gets one owner

The core pattern is **task ownership**. Each task is handed to exactly one
**owner agent** that owns it end-to-end and is accountable for the final result.
An owner may do small work itself, but for anything substantial it *orchestrates*
rather than grinding solo — it spawns its own subagents below it to get the task
done well (e.g. one subagent to explore the code, another to implement, another
to verify). Match the depth to the task: a one-shot chunk needs no subtree.

- **You are depth 0.** You own the owners.
- **Each owner is depth 1.** It owns its task and everything below it.
- **The owner's subagents are depth 2+.** The owner decides how to split them.

### One task → one owner

Spawn a **single** owner agent and hand it the whole task. Tell it explicitly
that it owns the task and should delegate to its own subagents rather than doing
everything itself — suggest the shape if it helps ("explore with one subagent,
implement with another, verify with a third"). It returns one synthesized result.

### Many tasks → one owner each, in parallel

Spawn **one owner per task in a single message** so they run concurrently. Each
owner independently manages its own subtree as it sees fit. You collect one
digest per owner and synthesize. Only split a single task across multiple owners
if its parts are genuinely independent — otherwise one owner, one task.

**Parallel owners need disjoint write scopes.** Before spawning, list each
owner's repos/paths; if two would touch the same files, merge them into one
owner or serialize. When owners must meet at a boundary, define the shared
contract up front (e.g. the interface both sides build against). And when one
change fans out across many targets, run one global consistency check across
*all* targets (grep the actual live values, don't assume uniformity) before any
PR opens — per-target workers won't catch the outlier.

## Owners must be able to re-delegate

An owner can only orchestrate if it has the **Agent tool**:

- **The `owner` agent (ships with this plugin) — prefer it.** Spawn it as
  `agent-ops:owner`. It keeps the Agent tool, preloads this skill, and carries
  the owner behaviors (digest contract, verify-workers, git discipline) in its
  own system prompt, so you don't have to re-pack those rules into every spawn.
- **Unrestricted types** (`general-purpose`, `claude`, `fork`) inherit every
  tool and also work as owners — pack the owner behaviors into the brief
  yourself.
- **Leaf types** whose fixed tool list omits Agent (`Explore`, `Plan`, every
  `*-developer` / specialist agent) can't delegate. They're great *workers*
  under an owner, but they can't *be* an owner. (Leafness is a definition
  choice, not a platform rule — any custom agent that lists `Agent` in its
  `tools:` frontmatter can re-delegate, down to the depth-5 ceiling.)

## Selecting the owner model

The model pinned on the **owner** is the most consequential model choice — it
runs the whole task's orchestration. Set it when spawning the owner. Honor an
optional owner-model selector from the invocation arguments, in either form:

- **flag:** `--model <name>` (e.g. `--model opus`)
- **prose:** "use an opus agent", "orchestrate this with sonnet"

Apply it as the `model` of the owner agent(s) spawned — **not** this skill's own
`model:` frontmatter, which only sets the depth-0 session running the skill. For
the many-tasks form, an optional per-task selector may set each owner's model
independently; otherwise apply one selector to all owners. Absent a selector, the
owner inherits the session model; as a default rule of thumb, give a strong
model to owners of multi-repo or design-heavy trees and cheaper models to
well-scoped single-repo owners. This is separate from pinning cheaper models on
the owner's *sub*-workers (see "Depth" below).

## Fork vs. fresh spawn

There are two ways to hand work to a subagent, differing in how much of *your*
context travels with it:

- **Fresh spawn with a packed brief (the default):** a clean agent that inherits
  CLAUDE.md, memory, and a git snapshot but **not** this conversation or the files
  you've read. You hand it a standalone task description, pointers, prior
  findings, and a return contract (see "Pack context down" below). Independent and
  isolated — the right choice almost always.
- **Fork** (the `fork` agent type): hand the child your *entire* current context —
  the conversation, the files you've read, the analysis so far — so it continues
  from where you are instead of rediscovering it. Reserve `fork` for a tight
  continuation of the work in flight, where that context transfer matters more
  than a clean slate.

Most orchestration uses fresh spawns with packed briefs; fork is the exception,
for when context continuity is genuinely critical.

## Borrowing a specialist's expertise as an owner

The prebuilt specialist agents (`rust-developer`, `ansible-developer`,
`security-analyst`, `go-developer`, …) carry valuable domain personas — but
they're leaves, so they can't own-and-delegate. Two ways to use them:

- **As a worker:** spawn the specialist directly for a scoped chunk *under* an
  owner. This is the normal case.
- **As an owner with that expertise:** agents are just markdown files. Spawn the
  plugin's `owner` agent (or another unrestricted type) and tell it to *become*
  the specialist:

  > "Read `<path>/agents/rust-developer.md`, adopt that role and its standards as
  > your own, then own this task as that agent — delegating to your own subagents
  > as you see fit."

  Two independent things are happening here — keep them straight. The
  **unrestricted agent type** is what keeps the Agent tool, so the owner can still
  delegate; **reading the specialist `.md`** is what shapes its judgment to that
  domain. The file read grants *persona, not tools*. This differs from spawning
  the specialist directly as a worker — that gives you the expertise but no
  orchestration ability. (Find the file via the plugin's `agents/` dir or
  `~/.claude/agents/`.)

## Depth: 5 levels, but stay shallow

Claude Code enforces a maximum nesting depth of **5**, automatically — you don't
set it. It's a technical ceiling (to prevent context runaway and keep subagents
responsive), not a design target. The depth is fixed when an agent is spawned: a
subagent at depth 5 gets no Agent tool and can't go deeper. In practice keep it
to **1–2 levels**: one owner per task (depth 1), workers under it (depth 2).
Reach for a deeper chain only when a worker's slice genuinely re-splits. Prefer
**breadth** (more siblings) over depth — depth multiplies context-loss and burns
toward the ceiling.

You can pin a cheaper/faster model per spawn — e.g. explore and implement with
`model: sonnet` subagents and reserve a stronger model for the hard verify step.

## Pack context down, return digests up

A fresh subagent inherits CLAUDE.md, memory, and a git snapshot — but **not** this
conversation, the files you've read, or what you've learned. So every spawn prompt
must carry:

- **The task**, stated standalone (readable by someone who never saw this chat).
- **Pointers**: exact paths, repo/branch/worktree, service names, URLs.
- **Prior findings** the child needs — paste them; it can't see them otherwise.
- **Constraints**: what not to touch, which test/lint/build commands to run, scope.
- **The return contract**: state exactly what to hand back and in what shape ("the
  PR URL", "a 5-bullet digest", "yes/no + the offending line") — a digest, **not**
  a transcript.

### Write the brief to a file

For anything beyond a one-liner, write the brief **once** to disk and pass each
owner the **absolute path** plus a short per-owner delta — don't re-paste the
same context into N spawn prompts. Durable work → a plan doc in the repo (e.g.
`docs/projects/<task>-plan.md`); ephemeral → a temp file, cleaned up when the
tree finishes. Owners can re-read it mid-task, and a re-spawned owner after a
crash picks up the exact same brief. Absolute paths only — agents working in
different worktrees resolve relative paths differently.

### Constraints every brief restates

Spawned agents inherit CLAUDE.md and memory but don't reliably *apply* standing
rules unprompted. Restate the ones that matter for this task, typically:

- work in a worktree; rebase on the latest default branch before opening the PR
  (detect it — `git symbolic-ref refs/remotes/origin/HEAD`; don't assume `main`)
- never merge; report PR URLs the moment they open
- no GUI/browser launches or other intrusions on the user's machine
- public-repo hygiene when the target repo is public

### Verify, don't trust

The dominant real-world failure mode is **silent under-delivery**: an owner
going idle without its digest, dying before it ever spawned its subtree, or
relaying a worker's "done" for work that never landed. So:

- An owner's **final message must be the digest**, PR URLs included. Going idle
  without one is a failure, not a completion.
- Before relaying "done" upward, **verify independently** — `git status`,
  `gh pr list`, the actual diff — never a subagent's self-report alone.
- A dead or idle agent can be **resumed with a message** ("continue where you
  left off — deliver your digest") or re-spawned against the same brief file.
  Treat a failure notification as an immediate resume; don't leave a dead owner
  waiting on the user to notice.

## When to reach for a different tool

- **A small, fully-diagnosed change** (one file, decision already made) → just
  do it inline; the spawn round-trip costs more than it saves.
- **Deterministic loops / large fan-out with control flow** (loop-until-dry,
  pipelines, fixed phases over a work-list) → the **Workflow** tool.
- **Sustained multi-session work where workers must message each other** → **agent
  teams**, not subagents.
- **A single scoped implementation or review** → just call the right specialist
  agent directly; you don't need an owner hierarchy for one delegate.

## Quick reference

| Decision                   | Rule                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Invoked this skill?        | You're delegating — don't do the work inline (sole exception: a small, fully-diagnosed change). |
| Ready?                     | Design discussed, "complete" defined, artifact homes known — else ask first. |
| One task                   | One owner agent (depth 1) that orchestrates its own subagents.     |
| Many tasks                 | One owner per task, spawned in parallel; each owns its subtree.    |
| Parallel owners            | Disjoint write scopes; shared contract at boundaries; one global check before fanout PRs. |
| Owner type                 | Prefer the plugin's `owner` agent; unrestricted types (`general-purpose` / `claude` / `fork`) also work. |
| Owner model                | Pick via `--model <name>` or prose ("use an opus agent"); sets the owner spawned, not the skill's own `model:`. |
| Worker-only types          | `Explore`, `Plan`, `*-developer` (no Agent tool).                  |
| Fork vs fresh              | Fresh packed brief by default; `fork` only for tight continuation. |
| Specialist as owner        | Spawn the `owner` agent; tell it to read the specialist `.md` and assume it. |
| Max nesting                | Depth 5, fixed at spawn. Keep it 1–2; prefer breadth.              |
| Context down               | Pack: task, pointers, prior findings, constraints, return shape — via a brief file for anything big. |
| Returns up                 | Digest with PR URLs — synthesize at each level; verify independently before relaying "done". |
| Dead/idle agent            | Resume with a message or re-spawn on the same brief; act on failure notifications immediately. |
| Sub-worker model           | Pin `model: sonnet` (etc.) on cheaper explore/implement steps.     |
| Deterministic pipeline     | Use the Workflow tool instead.                                     |
| Multi-session coordination | Use agent teams instead.                                           |
