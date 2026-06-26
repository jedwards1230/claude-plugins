# agent-ops

Subagent **fan-out discipline** — the decision aid you consult right before
delegating to agents and nesting them. It ships a single skill, `orchestrate`.

## What it does

The `orchestrate` skill captures the discipline for delegating and nesting
subagents with the plain Agent tool (not the Workflow tool, not agent teams):

- **When to delegate** vs. just do it inline (a lookup isn't worth a round-trip).
- **Depth & breadth**: the fixed depth-5 nesting cap, and why most work should
  stay 1–2 levels (breadth over depth).
- **Tool inheritance**: only unrestricted agent types (`general-purpose`,
  `claude`, `fork`) keep the Agent tool and can re-delegate; `Explore`, `Plan`,
  and `*-developer` agents are leaves.
- **Context on the way down**: a fresh subagent inherits CLAUDE.md/memory but
  **not** your conversation history, read files, or findings — so what to pack
  into every spawn prompt.
- **fork vs fresh**: when to hand a child your full context (`fork`) vs. a clean
  brief.
- **Returns on the way up**: summarize-on-return so deep hierarchies don't bloat
  the parent.

It is a **decision aid, not a session controller** — it makes the spawn good and
gets out of the way. For deterministic large fan-outs use the Workflow tool; for
sustained multi-session collaboration use agent teams.

## Skills

| Skill | When to Use | What It Covers |
|-------|------------|----------------|
| `orchestrate` | About to fan out / nest subagents | Delegate-or-not, depth/breadth, context-packing, fork-vs-fresh, return contracts, patterns, gotchas |

### Triggers

"orchestrate this", "fan out agents", "use subagents", "spawn agents in
parallel", "delegate this", "how should I split this work", "run a few agents on
this", "coordinate subagents", "nest agents".
