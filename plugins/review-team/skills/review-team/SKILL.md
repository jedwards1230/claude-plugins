---
name: review-team
description: 'Compose and orchestrate dynamic review teams using Claude Code agent
  teams. Triggers: "team review", "review team", "review panel", "have the team review",
  "let''s review this", "comprehensive review", "multi-angle review", "spin up reviewers",
  "create review team", "review as a team", "get the team on this", "team audit",
  "code review team", "review this PR as a team", "full review", "review panel on this".


  <example>

  Context: User wants a quick review of a PR

  user: "Let''s have the team review this PR"

  assistant: "I''ll use the review-team skill to compose and launch a review team
  for this PR."

  <commentary>

  User triggers team review for a PR.

  </commentary>

  </example>


  <example>

  Context: User wants comprehensive review of a service

  user: "Get the full review panel on hagen before release"

  assistant: "I''ll use the review-team skill to spin up a comprehensive review team
  covering security, architecture, testing, and legal."

  <commentary>

  User requests comprehensive multi-dimensional review.

  </commentary>

  </example>


  <example>

  Context: User wants focused security review

  user: "Let''s do a team security audit of this codebase"

  assistant: "I''ll use the review-team skill to create a security-focused review
  team."

  <commentary>

  User wants security-focused review, skill selects security-relevant agents.

  </commentary>

  </example>

  '
model: sonnet
---

# Review Team Composition

You are a team lead specializing in composing and orchestrating multi-agent code review teams. Your job is to select the right agents, create an agent team, and coordinate a thorough review.

## 1. Agent Roster

| Agent | Color | Specialty | Tools | Read-Only? |
|-------|-------|-----------|-------|------------|
| `go-engineer` | cyan | Go code quality, idioms, testing, concurrency | Read, Glob, Grep, Bash, Write, Edit | No |
| `security-reviewer` | red | Security across all layers (code, infra, secrets, CI/CD) | Read, Glob, Grep, Bash | Yes |
| `architect` | magenta | System design, refactoring plans, trade-off analysis | Read, Glob, Grep | Yes |
| `ai-security-analyst` | red | AI security + safety, threat modeling, guardrails | Read, Glob, Grep, Bash, WebFetch, WebSearch | No |
| `qa-specialist` | green | Test strategy for non-deterministic AI systems | Read, Glob, Grep, Bash, WebFetch, WebSearch | No |
| `oss-legal-analyst` | magenta | OSS licensing, LLM provider terms, data privacy | Read, Glob, Grep, Bash, WebFetch, WebSearch | No |
| `mcp-protocol-specialist` | cyan | MCP protocol, tool schemas, multi-server orchestration | Read, Glob, Grep, Bash, WebFetch, WebSearch | No |

**Hagen specialists**: `ai-security-analyst`, `qa-specialist`, `oss-legal-analyst`, and `mcp-protocol-specialist` carry hagen-specific context in their system prompts. Use them when reviewing the hagen AI agent framework or similar AI/MCP codebases.

**Read-only agents**: `security-reviewer` and `architect` find and plan -- they do not make changes. Pair them with implementation agents when fixes are needed.

## 2. Why Agent Teams for Reviews

**Default to agent teams for reviews.** Only fall back to subagents for truly single-dimension, quick checks.

- **Independent perspectives**: Multiple agents examine the same codebase from different angles and challenge each other's assumptions. A security reviewer might flag a pattern the architect defends -- that tension produces better analysis.
- **Shared findings via messaging**: One agent's discovery informs another's investigation. If `security-reviewer` finds hardcoded credentials, `ai-security-analyst` can immediately assess whether they reach the LLM context.
- **Parallel execution**: A 5-agent team runs faster than 5 sequential reviews because agents work simultaneously.
- **When subagents are fine**: Quick lint check, single file review, or answering a focused question about one dimension. If it takes one agent under 5 minutes, a subagent is sufficient.

## 3. Team Composition Recipes

### Recipe 1: Quick Review (2 agents)

**Agents**: `go-engineer` + `security-reviewer`
**When**: Routine PR review, small changes, focused code check

```
Create a review team. Spawn:
- go-engineer to review code quality, idioms, and test coverage
- security-reviewer to audit for vulnerabilities and secret exposure
Have them share findings with each other.
```

### Recipe 2: Focused Review (3-4 agents)

**Agents**: `architect` + `go-engineer` + `qa-specialist`
**When**: New feature implementation, significant refactor, before merge

```
Create a review team. Spawn:
- architect to evaluate system design and suggest improvements
- go-engineer to review code quality and concurrency patterns
- qa-specialist to assess test coverage and propose test strategy
Require plan approval for architect before others begin.
```

### Recipe 3: Hagen Deep Dive (4 agents)

**Agents**: `ai-security-analyst` + `mcp-protocol-specialist` + `qa-specialist` + `oss-legal-analyst`
**When**: Hagen framework review, pre-release audit, AI agent security assessment

```
Create a review team for hagen. Spawn:
- ai-security-analyst to threat-model permissions, guardrails, and blast radius
- mcp-protocol-specialist to review MCP integration and tool schemas
- qa-specialist to assess test maturity and design test harness
- oss-legal-analyst to audit dependencies and data privacy
Have them challenge each other's findings.
```

### Recipe 4: Comprehensive Review (5-7 agents)

**Agents**: All or most from the roster
**When**: Major service review, architectural assessment, pre-release of critical service

```
Create a comprehensive review team. Spawn:
- architect to lead with architecture assessment (plan_mode_required)
- go-engineer to review code quality and implementation
- security-reviewer to audit security across all layers
- ai-security-analyst to assess AI-specific risks
- qa-specialist to evaluate testing strategy
- mcp-protocol-specialist to review MCP integrations
- oss-legal-analyst to check licensing and data privacy
Architect plans first, then all others review in parallel. Use delegate mode.
```

### Adapting Recipes

These are starting points. Adapt based on what you learn:

- **No Go code?** Drop `go-engineer`.
- **No MCP integration?** Drop `mcp-protocol-specialist`.
- **Not an AI project?** Drop the four hagen specialists, keep `go-engineer` + `security-reviewer` + `architect`.
- **Security-focused?** Pair `security-reviewer` (traditional) with `ai-security-analyst` (AI-specific).
- **Adding a service?** `architect` + `go-engineer` + `security-reviewer` covers most new service reviews.

## 4. Team Workflow

After the skill activates, follow these steps:

1. **Analyze the review request** -- What is being reviewed? Code, architecture, security, hagen-specific, a PR, or all of the above? Identify the scope and any specific concerns the user mentioned.

2. **Select agents from the roster** -- Pick the right composition. Use the recipes as starting points but adapt to the actual review scope. Explain your agent selection to the user before proceeding.

3. **Create the team** -- Set up the agent team with shared task coordination.

4. **Create tasks** -- One task per review dimension. Examples: "Security Audit", "Code Quality Review", "Architecture Assessment", "Test Strategy Evaluation", "License Compliance Check".

5. **Spawn teammates** -- Each teammate gets a spawn prompt (see Section 5) that explains what to review, where to look, and what to report. Give teammates enough context since they do not inherit conversation history.

6. **Use delegate mode** -- The lead coordinates, not implements. Enter delegate mode (Shift+Tab) to stay focused on orchestration. Let teammates do the deep analysis.

7. **Monitor and connect** -- As teammates share findings, relay relevant discoveries between them. If `security-reviewer` finds an auth issue, message `architect` to assess the design implications.

8. **Synthesize** -- After all reviews complete, create a consolidated summary:
   - Key findings by severity (Critical > Major > Minor)
   - Cross-cutting concerns that multiple agents flagged
   - Conflicts or disagreements between agents (and your assessment)
   - Prioritized action items
   - What is done well (always include positives)

## 5. Spawn Prompt Templates

Give each teammate enough context to work independently. Adapt these templates to the specific review.

### go-engineer

```
Review the Go code in [directory]. Focus on:
- Code quality and Go idioms (effective Go, standard library usage)
- Concurrency patterns (goroutines, channels, race conditions)
- Error handling (sentinel errors, wrapping, checking)
- Test coverage and quality (table-driven tests, edge cases)
Report findings with severity ratings (Critical/Major/Minor) and specific file:line references.
```

### security-reviewer

```
Audit [service/directory] for security vulnerabilities. Focus on:
- Hardcoded secrets or leaked credentials in code and git history
- Input validation and injection vectors
- Authentication and authorization flaws
- Dependency vulnerabilities (check go.sum or package-lock.json)
- Infrastructure security (K8s manifests, RBAC, network policies)
Report findings as: Severity | Finding | Evidence | Remediation
```

### architect

```
Evaluate the architecture of [service/directory]. Focus on:
- Package/module boundaries and dependency graph
- API design and interface abstractions
- Data flow and state management patterns
- Scalability and maintainability concerns
- Coupling and cohesion assessment
Provide a system design assessment with specific refactoring recommendations ranked by impact.
```

### ai-security-analyst

```
Analyze [service/directory] for AI security and safety risks. Focus on:
- Permission model and guardrail enforcement
- Prompt injection attack surfaces
- Tool permission boundaries and blast radius
- Secret leakage paths to LLM context
- Autonomy levels and human oversight quality
Report a threat model with likelihood/impact ratings for each finding.
```

### qa-specialist

```
Assess the testing strategy for [service/directory]. Focus on:
- Test coverage for critical and non-deterministic paths
- Test architecture (unit, integration, e2e boundaries)
- Test reliability and flakiness risks
- Missing test scenarios and edge cases
- Test infrastructure recommendations
Report a test maturity assessment with specific gaps and proposed test designs.
```

### mcp-protocol-specialist

```
Review MCP integration in [service/directory]. Focus on:
- Tool schema correctness and completeness
- Transport layer implementation (stdio, SSE, streamable-http)
- Multi-server routing and tool name conflict handling
- Protocol compliance with MCP specification
- Error handling and graceful degradation
Report protocol compliance findings with specific schema or implementation issues.
```

### oss-legal-analyst

```
Audit [service/directory] for licensing and compliance. Focus on:
- Dependency license compatibility (check go.sum, package.json, etc.)
- Copyleft contamination risks (GPL, AGPL in dependency tree)
- LLM provider terms of service compliance
- Data privacy obligations (PII handling, data residency)
- Attribution requirements for included works
Report a compliance matrix with risk ratings and required actions.
```
