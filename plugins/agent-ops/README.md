# agent-ops

Subagent **fan-out discipline** — the decision aid you consult right before
delegating to agents and nesting them. It ships one skill, `orchestrate`, and
one premade agent, `owner`.

## What it does

The `orchestrate` skill captures the discipline for delegating and nesting
subagents with the plain Agent tool (not the Workflow tool, not agent teams):

- **Readiness**: the pre-spawn gate — design discussed, "complete" defined,
  artifact homes known, open questions asked first.
- **When to delegate** vs. just do it inline (a lookup isn't worth a round-trip).
- **Depth & breadth**: the fixed depth-5 nesting cap, and why most work should
  stay 1–2 levels (breadth over depth).
- **Tool inheritance**: an owner needs the Agent tool to re-delegate — the
  plugin's `owner` agent and unrestricted types (`general-purpose`, `claude`,
  `fork`) have it; `Explore`, `Plan`, and `*-developer` agents are leaves.
- **Context on the way down**: a fresh subagent inherits CLAUDE.md/memory but
  **not** your conversation history, read files, or findings — so pack every
  spawn prompt, via a shared **brief file** for anything big.
- **Parallel safety**: disjoint write scopes between owners, shared contracts at
  boundaries, one global consistency check before fanout PRs.
- **fork vs fresh**: when to hand a child your full context (`fork`) vs. a clean
  brief.
- **Returns on the way up**: a mandatory final digest (PR URLs included),
  verified independently — plus how to recover dead or idle agents.

It is a **decision aid, not a session controller** — it makes the spawn good and
gets out of the way. For deterministic large fan-outs use the Workflow tool; for
sustained multi-session collaboration use agent teams.

## Skills

| Skill | When to Use | What It Covers |
|-------|------------|----------------|
| `orchestrate` | About to fan out / nest subagents | Readiness gate, delegate-or-not, depth/breadth, brief files, context-packing, fork-vs-fresh, return contracts, recovery, patterns, gotchas |

## Agents

| Agent | Role |
|-------|------|
| `owner` | The depth-1 task owner the skill spawns: keeps the Agent tool so it can re-delegate, preloads the `orchestrate` skill for the knowledge, and bakes the owner discipline (verify workers' diffs, disjoint scopes, worktree + rebase, never merge, report PR URLs, mandatory final digest) into its system prompt so it doesn't have to be re-packed into every spawn. |

### Triggers

"orchestrate this", "fan out agents", "use subagents", "spawn agents in
parallel", "delegate this", "how should I split this work", "run a few agents on
this", "coordinate subagents", "nest agents".
