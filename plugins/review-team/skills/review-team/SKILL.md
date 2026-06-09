---
name: review-team
description: 'Compose and orchestrate dynamic review teams using Claude Code agent
  teams. Triggers: "team review", "review team", "review panel", "have the team review",
  "comprehensive review", "multi-angle review", "spin up reviewers", "create review
  team", "team audit", "security audit", "code review team", "review this PR as a
  team", "full review".


  <example>

  Context: User wants comprehensive review of a service

  user: "Get the full review panel on this service before we ship"

  assistant: "I''ll use the review-team skill to spin up a team covering security,
  engineering, testing, and product."

  </example>

  '
model: sonnet
---

# Review Team — Index

Compose a multi-agent review team: pick agents, create the team, coordinate, synthesize.
Each agent's full brief — scope, focus areas, how it reports — lives in its definition
file at `agents/<name>.md`. Spawn teammates with task-specific context from there.

Agents are generic and stack-agnostic; every one inherits the session's tools, so any
agent can both review and do the work in its domain.

## Agents

| Agent | Specialty |
|-------|-----------|
| `security-analyst` | App, infra & AI/data security; vulns, secrets, auth, supply chain |
| `software-engineer` | Code quality, correctness, idioms, tests — any language |
| `platform-engineer` | CI/CD, IaC, containers, deployment, observability, DX |
| `data-engineer` | Pipelines, schema & data modeling, ETL, data quality, migrations |
| `ai-specialist` | LLM/agent systems, prompts, evals, retrieval, guardrails |
| `qa-technician` | Test strategy, coverage, flakiness, regression — any stack |
| `product-manager` | Requirements, scope, user value, acceptance criteria, trade-offs |
| `frontend-designer` | UI/UX, interaction design, responsiveness, accessibility |
| `legal-expert` | OSS licensing, ToS, data privacy/compliance, attribution |
| `technical-writer` | Docs accuracy, READMEs, API docs, ADRs, onboarding |
| `devils-advocate` | Challenges the direction itself — assumptions, consensus, the rejected option (meta-review, not domain review) |

## Recipes

Starting points — drop agents that don't apply, add any the work touches.

| Recipe | Agents | When |
|--------|--------|------|
| Quick | `software-engineer` + `security-analyst` | Routine PR, small change |
| Feature | `product-manager` + `software-engineer` + `qa-technician` | New feature before merge |
| Frontend | `frontend-designer` + `software-engineer` + `qa-technician` | UI work, design + a11y review |
| Data / AI | `data-engineer` + `ai-specialist` + `security-analyst` | Data pipeline or LLM feature |
| Platform | `platform-engineer` + `security-analyst` + `software-engineer` | CI/CD, IaC, or deployment change |
| Release | `security-analyst` + `legal-expert` + `technical-writer` | Pre-release licensing/security/docs audit |
| Comprehensive | most of the roster | Major service / architectural review |

`devils-advocate` is not a domain reviewer — add it to any recipe for a high-stakes,
hard-to-reverse, or gate decision (ship / merge / architecture sign-off). Run it **after**
the domain reviewers report and their findings are consolidated, not in parallel — it
needs a settled direction to attack. Skip it on routine PRs.

## Running a team

Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Create the team with one task per
review dimension; spawn each teammate with task-specific context (they don't inherit
conversation history) and ask for severity-rated findings with `file:line` references.
The lead coordinates and synthesizes findings — it does not implement.

**Synthesize** the teammates' reports into one severity-ordered summary: dedupe overlapping
findings (note which agent raised each), surface Critical/High first, and flag any
disagreements between agents rather than silently resolving them.

**When not to use a team:** teams cost several times more than a single agent. For small,
sequential, or token-sensitive work — or a single-dimension check one agent finishes in
under ~5 minutes — use one agent or a plain subagent instead.
