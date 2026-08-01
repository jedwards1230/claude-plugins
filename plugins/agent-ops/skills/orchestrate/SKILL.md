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
  Also carries an OPT-IN integration-branch topology — many agent PRs built up
  into one branch so the human reviews and merges exactly one thing — requested
  with: "use an integration branch", "integration branch", "use a staging
  branch", "bundle these into one PR", "one PR at the end", "I'll review one PR",
  "merge them into one branch for review".


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


  <example>

  Context: The user explicitly asks for the integration-branch topology.

  user: "Orchestrate these six issues, but use an integration branch — I only want
  to review one PR."

  assistant: "Integration-branch flow, then. I'll cut `integration/<scope>` off the
  default branch, open the draft tracking PR up front so you can watch the
  checklist fill in, land the shared schema change, then fan out owners on
  disjoint file scopes — each PR based on the integration branch, not the default
  branch. I merge those as they go green; you review and merge the one tracking PR
  at the end."

  <commentary>

  Opt-in topology — I use it because the user asked, not because the work looked
  big. Without that ask, each task would get its own PR straight to the default
  branch.

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
- never merge into the default branch; merge a feature PR into an integration
  branch only if the brief names you as the grant holder; report PR URLs the
  moment they open
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

## Integration-branch flow (opt-in): one review surface for a multi-PR build

**Off by default — the user asks for it.** Requested with "use an integration
branch", "use a staging branch", "bundle these into one PR", "one PR at the end",
"I'll review one PR". If the work looks too big for one PR but the user *didn't*
ask, **suggest it and let them choose** — don't assume it. Absent the ask, the
default stands: one PR per task, based on the default branch.

*Integration branch* and *staging branch* are the same thing; the user's wording
sets which name to use for the run.

A topology choice **orthogonal** to one-owner-vs-N-owners: the agents build up one
branch — each owning its own CI-to-green loop and merging into it as it's ready —
while you keep that branch healthy and the human reviews and merges exactly
**one** thing at the end. (Milestones and PRDs are just one instantiation; the
shape is structural, not tied to them.)

### Pre-flight, before spawning anything

1. **Cut the integration branch** off the default branch, seed it with an **empty
   commit**, and push. A PR can't exist without a commit — zero commits ahead of
   the default branch leaves `gh pr create` nothing to open against — and an empty
   commit leaves no tracking file to delete before promotion. Always pass `-m`
   (`git commit --allow-empty -m "chore: seed integration branch"`); without it git
   opens an editor and hangs a non-interactive run.
2. **Open the draft tracking PR** (integration → default) **now, before any owner
   spawns.** Body: a short overview of the work plus an **unchecked** checklist of
   every planned item, so it reads as the plan from the first minute and the user
   watches it fill in rather than seeing it appear retroactively.
3. **Fix the CI trigger.** `on: pull_request: branches: [main]` **silently skips
   stacked PRs** whose base is the integration branch — they report a meaningless
   green. Add the integration base, then confirm a stacked PR actually shows
   build/lint/test. The review bot has its own trigger and fires regardless, so
   its presence proves nothing. **Don't retire the fix until every stacked PR has
   landed** — verify with `gh pr list --base <integration>`, don't assume.
4. **Confirm nothing auto-deploys or auto-releases off the branch** — CD that
   tracks a branch pattern, or a release workflow that isn't default-branch-only.
5. **Land the shared prerequisite first**, as its own PR, before any owner
   branches: dependency bumps, schema/migration, generated types, config scaffold.
   Skip this and every owner conflicts in the same lockfile or schema file.
6. **Write the brief to disk and name who holds the merge grant** — "the
   orchestrator only", or "this repo's owner" in a multi-repo run, explicitly. An
   owner reading a bare "never merge" can't tell whether the grant applies to it,
   and will ask or stall.

### Topology

- Feature branches take the **hyphen** form `<integration>-<topic>` — never
  `<integration>/<topic>`: git can't hold both a ref named `<integration>` and one
  nested under `<integration>/` (directory/file conflict), so the slash form is
  impossible while the integration branch exists. A `<prefix>/<name>` integration
  branch (e.g. `integration/<scope>`) avoids the clash and lets features keep
  conventional `feat/<topic>` names.
- Every feature PR targets **base = the integration branch**, never the default
  branch. Owners verify their own base (`gh pr view --json baseRefName`) before
  reporting ready.
- **Split owners by disjoint file scope, not by issue count.** Five issues where
  four of them edit one config file is a *two*-owner job, not five — fanning out
  per-issue there guarantees collisions. Assign each owner an explicit path glob
  and check the delivered diff against it.

### One review surface

The **draft** tracking PR (integration → default) opens in pre-flight, before any
owner spawns — it is the user's monitoring surface for the whole run, so it starts
as the full unchecked plan and its body stays current as feature PRs land. It
stays draft until promotion — which is also the review throttle: an un-suppressed
growing integration diff has triggered 13–16 full auto-review passes per repo.

**Re-list every `Closes #N` on the tracking PR body.** A closing keyword in a
feature PR merged into the integration branch **never fires** — the issue stays
open because the merge didn't land on the default branch. Only the tracking PR's
own body closes anything. Corollary: in a repo run this way, an open issue is not
evidence of unfinished work.

### Two-tier merge authority

- *Feature PRs into the integration branch* — merged autonomously under a
  **scoped standing merge grant** from the user. In a single-repo run the grant
  sits with you (the orchestrator); in a **multi-repo run with one owner per
  repo**, give it to the per-repo owner — it holds the ci-watch loop, the review
  threads, and the scope-vs-brief context a central hop lacks. Either way **the
  brief names the holder explicitly.** The merge is gated on:
  - **the review check reaching a terminal state** — *not* a thread count. "0 of 0
    threads" reads identically whether review found nothing or **hadn't started
    yet**; treat "no threads" as unknown until the check concludes.
  - all review threads then read and resolved.
  - CI green — necessary, not sufficient (CI-green merges have shipped
    goroutine/fd leaks `go test -race` doesn't catch).
  - an explicit **verified-ready** state — the owner's hand-off, or, when the
    owner holds the grant, its own verified-ready bar met.
  - an independent check by whoever merges: base branch, mergeable state,
    delivered file scope vs assigned scope, secret scan.
- **Merging a PR cancels its in-flight review.** Merging early doesn't merely risk
  missing findings — it destroys them, leaving that PR with zero review coverage
  in the final diff.
- *Integration → default* — **always merged by the human.** The grant is per-run
  and never carries over; renew it explicitly.

### Running the branch

- **Agents own the CI loop.** Each owner arms ci-watch on its PR, fixes red CI,
  answers and resolves review-bot threads, and flips its PR draft→ready itself.
  The grant holder merges; nobody babysits the loop.
- **Conflict handling is its own role.** After each merge, check the remaining
  open PRs for conflicts/staleness and spawn a **short-lived rebase agent per
  conflicted PR** — a mechanical rebase doesn't go back to the feature owner.
  Route only *semantic* conflicts to the still-idle owner (via SendMessage) — it
  holds the context.
- **Live-test loop.** Bugs found in manual/live testing route back as new tasks to
  the **same idle owner** via SendMessage (repro + diagnosis direction +
  failing-test-first), not fresh spawns — the owner still holds the context.
- **Cross-repo dependents.** One integration branch **per repo** — a single PR
  can't span repos. Give them the same name where possible. Have the dependent
  build against the last *release* of its dependency rather than an in-flight
  branch so it's never blocked; when it must re-pin, **verify the pin actually
  moved on the remote**, never relaying a subagent's "done".
- **Promotion.** Adversarial review sweep over the *full* integration diff → fix
  wave → human merges the tracking PR → auto-delete retires the branch.

### Worked example

Six issues, one repo, user asked for an integration branch:

1. Cut `integration/api-v2` off `main` with an empty seed commit, push.
2. Open the draft tracking PR `integration/api-v2 → main` — body = an overview
   plus the six-item checklist, all unchecked. This is what the user watches.
3. Add the branch to the CI `pull_request` bases; open a throwaway stacked PR to
   confirm build/lint/test actually run.
4. Land `integration/api-v2` ← one prerequisite PR adding the shared config
   schema all six features read.
5. Write `docs/projects/api-v2-plan.md`: the six slices, an explicit path glob per
   slice, the shared contract at their boundaries, and "merge grant: orchestrator
   only; the human merges the tracking PR."
6. Spawn owners **in one message** — three, not six, because slices 2–4 all edit
   the same router file. Each gets the brief path plus its slice delta.
7. As each PR goes green and its review concludes: read threads, verify base +
   scope, merge. Tick the checklist. Spawn a rebase agent for whatever went
   stale.
8. Route live-test bugs back to the owning agent; they land inside the same
   integration PR rather than as follow-ups.
9. At promotion: adversarial sweep over the full diff, fix wave, re-list all six
   `Closes #N` in the tracking PR body, mark ready, hand to the human.

### Footguns (each hit for real)

- Squash-merging the tracking PR **deletes the integration branch**, orphaning any
  dependent repo's pseudo-version pin — dependents must re-pin to a real release
  tag at promotion.
- Never commit or merge from a live owner's worktree — a sub-worker's "done" ≠ the
  owner is done; torn snapshots pass local gates and fail CI.
- Editing the brief file *after* spawning doesn't reach the owners already running.
  Re-send changed constraints by SendMessage.

### Optional: a per-run tracking artifact

The lead can instantiate a small checklist per run — integration branch name,
tracking PR numbers, per-owner path scopes, and the grant's scope + expiry — so
the run's state and the bounds of the merge grant are written down rather than
reconstructed from memory.

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
| User asked for an integration branch | Integration-branch flow (opt-in): open the draft tracking PR before spawning, pre-flight the CI trigger, land the shared prerequisite, feature PRs based on the integration branch; those merge under a scoped grant whose holder the brief names (you, or the per-repo owner in a multi-repo run); the human merges integration→default once. |
| Too big for one PR, user didn't ask | **Suggest** the integration branch; don't assume it. Default is one PR per task, based on the default branch. |
| Owner split under integration flow | By disjoint file scope, not issue count — re-list every `Closes #N` on the tracking PR or nothing closes. |
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
