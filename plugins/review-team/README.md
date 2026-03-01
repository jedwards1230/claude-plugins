# review-team

Dynamic review team composition with specialized agents for collaborative, multi-angle code review using Claude Code agent teams.

## Agent Roster

| Agent | Specialty | Read-Only? |
|-------|-----------|------------|
| `go-engineer` | Go code quality, idioms, testing, concurrency | No |
| `security-reviewer` | Security across all layers (code, infra, secrets, CI/CD) | Yes |
| `architect` | System design, refactoring plans, trade-off analysis | Yes |
| `ai-security-analyst` | AI security + safety, threat modeling, guardrails | No |
| `qa-specialist` | Test strategy for non-deterministic AI systems | No |
| `oss-legal-analyst` | OSS licensing, LLM provider terms, data privacy | No |
| `mcp-protocol-specialist` | MCP protocol, tool schemas, multi-server orchestration | No |

The first three are general-purpose infrastructure agents. The last four carry kova-specific context for AI agent framework reviews.

## Usage

The skill activates automatically when discussing team reviews:

```
> Let's have the team review this
> Get the full review panel on kova
> Do a team security audit of this codebase
> Review this PR as a team
```

## Team Compositions

| Recipe | Agents | When |
|--------|--------|------|
| **Quick Review** | `go-engineer` + `security-reviewer` | Routine PRs, small changes |
| **Focused Review** | `architect` + `go-engineer` + `qa-specialist` | New features, significant refactors |
| **Kova Deep Dive** | All 4 kova specialists | AI agent framework, pre-release audit |
| **Comprehensive** | All 5-7 agents | Major service review, architectural assessment |

See the skill file for full recipes, spawn prompt templates, and adaptation guidance.

## Prerequisites

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your Claude Code settings.json
- Agent definition files in the `agents/` directory
