# Grafana Dashboards Plugin

A Claude Code plugin for creating and managing Grafana dashboards as Kubernetes resources using the Grafana Operator.

## Features

- **grafana-dashboards skill**: Expert guidance for dashboard creation, panel design, and PromQL/LogQL queries
- **dashboard-reviewer agent**: Automated quality review against design best practices
- **Comprehensive design principles**: Based on Google SRE, Tufte, and industry standards

## Components

| Component | Type | Description |
|-----------|------|-------------|
| `grafana-dashboards` | Skill | Dashboard creation, CRD patterns, query building |
| `dashboard-reviewer` | Agent | Quality review with severity categorization |
| `DESIGN-PRINCIPLES.md` | Reference | Monitoring theory (Golden Signals, RED, USE) |
| `PANEL-PATTERNS.md` | Reference | JSON templates for common panel types |

## Installation

This plugin is distributed via the `claude-plugins` repository. Add it to your project by including it in your plugin path or cloning the repository.

## Local Configuration Required

This plugin provides **generic, portable** dashboard knowledge. Your project must provide **repo-specific configuration**.

### Setup (One-time)

Create `.claude/rules/plugins/grafana-dashboards.md` in your project with:

```markdown
# Grafana Dashboards Configuration

## Datasource UIDs

| Datasource | UID | Type |
|------------|-----|------|
| Prometheus | `your-prometheus-uid` | prometheus |
| Loki | `your-loki-uid` | loki |
| Tempo | `your-tempo-uid` | tempo |

## Grafana Deployment

- **Namespace**: `monitoring`
- **URL**: https://your-grafana.example.com

### Instance Selector
\`\`\`yaml
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
\`\`\`

## File Organization

- **Dashboard path**: `path/to/your/dashboards/`
- **Folders**: List your folder categories here

## Deployment Commands

\`\`\`bash
kubectl apply -k path/to/dashboards/ --server-side --force-conflicts
\`\`\`
```

### Discovering Datasource UIDs

If you don't know your datasource UIDs, use the Grafana MCP tool:

```
Use mcp__grafana__list_datasources to show me my Grafana datasources
```

## Usage

### Creating Dashboards

```
Create a dashboard for monitoring my Redis cluster
```

The skill will guide you through:
1. Choosing the right monitoring methodology (RED for services, USE for infrastructure)
2. Selecting appropriate panel types
3. Writing correct PromQL/LogQL queries
4. Following design best practices

### Reviewing Dashboards

```
Review the dashboard at k8s/apps/monitoring/grafana/dashboards/my-dashboard.yaml
```

Or review a deployed dashboard:

```
Review the Redis dashboard in Grafana
```

The dashboard-reviewer agent will check:
- Panel count and layout
- 5-second rule compliance
- Query correctness (validates against live Grafana)
- Color semantics and accessibility
- Design principle adherence

## Design Principles

The plugin enforces industry best practices:

| Principle | Guideline |
|-----------|-----------|
| **Panel count** | 5-9 panels per dashboard (Miller's Law) |
| **5-second rule** | Understand status within 5 seconds |
| **Information hierarchy** | Important at top, details at bottom |
| **Semantic colors** | Red=bad, green=good, blue=info |
| **Accessibility** | Blue-orange palette, grayscale test |

See `DESIGN-PRINCIPLES.md` for comprehensive theory including:
- Framework Selection Guide with decision trees (Section 2)
- Four Golden Signals, RED, USE, and DORA methodologies (Sections 1, 4)
- Developer productivity frameworks: SPACE, DevEx, DX Core 4 (Section 5)
- Tufte's data-ink ratio and Gestalt principles (Section 6)
- GenAI/LLM observability with OTel conventions (Section 12)
- Specialized domains: backups, security, FinOps, games, dev tools (Section 11)

## Monitoring Frameworks

This plugin covers all major monitoring methodologies:

| Framework | Best For | Key Metrics |
|-----------|----------|-------------|
| **Four Golden Signals** | User-facing services | Latency, Traffic, Errors, Saturation |
| **RED Method** | Microservices | Rate, Errors, Duration |
| **USE Method** | Infrastructure | Utilization, Saturation, Errors |
| **DORA Metrics** | CI/CD pipelines | Deploy Freq, Lead Time, CFR, MTTR |
| **SPACE Framework** | Developer productivity | 5 dimensions (see docs) |
| **DevEx Framework** | Developer experience | Feedback loops, Cognitive load, Flow |
| **DX Core 4** | Holistic engineering | Speed, Effectiveness, Quality, Impact |
| **OTel GenAI** | AI/LLM applications | Tokens, Duration, Model, Cost |

Use the [Framework Selection Guide](./skills/grafana-dashboards/DESIGN-PRINCIPLES.md#2-framework-selection-guide) (Section 2) to choose the right approach for your dashboard.

### Specialized Domains

The plugin also covers monitoring scenarios where standard frameworks don't fit:
- Backups and compliance (RPO/RTO visualization)
- Security and threat detection (SIEM dashboards)
- FinOps and cost observability
- Game servers (TPS, player experience)
- Developer tools and CLI telemetry
- External systems (NAS, routers, UPS)

## Requirements

- Grafana with Grafana Operator installed
- Grafana MCP server configured (for query validation)
- Kubernetes cluster with kubectl access

## Contributing

This plugin is part of the `claude-plugins` repository. Contributions welcome!

## License

See repository LICENSE file.
