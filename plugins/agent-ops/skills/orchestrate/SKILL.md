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

  assistant: "Spawning one owner agent (general-purpose) that owns the whole
  task. It'll orchestrate its own subagents — one to explore the existing
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
---

# Orchestrate

Orchestration means handing work to a hierarchy of agents rather than doing it
yourself. The decision isn't *whether* to delegate — it's how to shape the tree
and what context to pack into each spawn. Set up the ownership hierarchy, spawn
it, then synthesize what comes back.

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

## Owners must be able to re-delegate

An owner can only orchestrate if it still has the **Agent tool**. That depends on
its type:

- **Unrestricted types** (`general-purpose`, `claude`, `fork`) inherit every tool
  and **can** spawn subagents. **Owners must be one of these.**
- **Leaf types** with a fixed tool list (`Explore`, `Plan`, every `*-developer` /
  specialist agent) have **no** Agent tool — they can't delegate. They're great
  *workers* under an owner, but they can't *be* an owner.

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

The prebuilt specialist agents (`rust-developer`, `k8s-engineer`,
`security-analyst`, `go-developer`, …) carry valuable domain personas — but
they're leaves, so they can't own-and-delegate. Two ways to use them:

- **As a worker:** spawn the specialist directly for a scoped chunk *under* an
  owner. This is the normal case.
- **As an owner with that expertise:** agents are just markdown files. Spawn an
  **unrestricted** agent and tell it to *become* the specialist:

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

On the way up, each owner synthesizes its subagents' digests into something
smaller before handing it to you. Restate the conclusion in your own words — the
user never sees the subagents' raw output.

## When to reach for a different tool

- **Deterministic loops / large fan-out with control flow** (loop-until-dry,
  pipelines, fixed phases over a work-list) → the **Workflow** tool.
- **Sustained multi-session work where workers must message each other** → **agent
  teams**, not subagents.
- **A single scoped implementation or review** → just call the right specialist
  agent directly; you don't need an owner hierarchy for one delegate.

## Quick reference

| Decision                   | Rule                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Invoked this skill?        | You're delegating. Don't do the work inline.                       |
| One task                   | One owner agent (depth 1) that orchestrates its own subagents.     |
| Many tasks                 | One owner per task, spawned in parallel; each owns its subtree.    |
| Owner type                 | Must be unrestricted (`general-purpose` / `claude` / `fork`).      |
| Worker-only types          | `Explore`, `Plan`, `*-developer` (no Agent tool).                  |
| Fork vs fresh              | Fresh packed brief by default; `fork` only for tight continuation. |
| Specialist as owner        | Spawn unrestricted; tell it to read the agent `.md` and assume it. |
| Max nesting                | Depth 5, fixed at spawn. Keep it 1–2; prefer breadth.              |
| Context down               | Pack: task, pointers, prior findings, constraints, return shape.   |
| Returns up                 | Digest, not transcript — synthesize at each level.                 |
| Per-spawn model            | Pin `model: sonnet` (etc.) on cheaper explore/implement steps.     |
| Deterministic pipeline     | Use the Workflow tool instead.                                     |
| Multi-session coordination | Use agent teams instead.                                           |
