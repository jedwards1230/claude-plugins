# review-team

Dynamic review team composition with specialized, stack-agnostic agents for collaborative, multi-angle review using Claude Code agent teams.

## Agent Roster

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
| `devils-advocate` | Challenges the direction itself — assumptions, consensus, the rejected option (meta-review; runs after domain reviewers, at gate decisions) |
| `public-repo-auditor` | Pre-publication safety sweep — secrets, internal/personal references, AI-conversation remnants, community-readiness |
| `claude-config-reviewer` | Claude Code config (CLAUDE.md, rules, agents, hooks, settings) checked against the official docs |

Every agent is generic and reusable — no project-, framework-, or tool-specific assumptions. Each inherits the session's tools, so any agent can both review and do the work in its domain.

## Usage

The skill activates automatically when discussing team reviews:

```
> Let's have the team review this
> Get the full review panel on this service
> Do a team security audit of this codebase
> Review this PR as a team
```

## Team Compositions

| Recipe | Agents | When |
|--------|--------|------|
| **Quick** | `software-engineer` + `security-analyst` | Routine PRs, small changes |
| **Feature** | `product-manager` + `software-engineer` + `qa-technician` | New features before merge |
| **Frontend** | `frontend-designer` + `software-engineer` + `qa-technician` | UI work, design + a11y review |
| **Data / AI** | `data-engineer` + `ai-specialist` + `security-analyst` | Data pipelines or LLM features |
| **Release** | `security-analyst` + `legal-expert` + `technical-writer` | Pre-release licensing/security/docs audit |
| **Go public** | `public-repo-auditor` + `technical-writer` + `legal-expert` | Before flipping a private repo to public — secrets, leakage, docs, license |
| **Claude config** | `claude-config-reviewer` + `technical-writer` | Reviewing CLAUDE.md, rules, agents, hooks, and settings |
| **Comprehensive** | Most of the roster | Major service review, architectural assessment |

See the skill file for the team-composition index, and each agent's definition in `agents/` for its full brief.

## Prerequisites

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your Claude Code settings.json
- Agent definition files in the `agents/` directory
