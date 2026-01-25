---
name: grafana-dashboards
description: This skill should be used when creating, editing, or managing Grafana dashboards as Kubernetes resources. Trigger phrases include "create dashboard", "add panel", "edit dashboard JSON", "dashboard variable", "template variable", "GrafanaDashboard CRD", "PromQL query for dashboard", "LogQL query for dashboard", "stat panel", "time series panel", "gauge panel", "pie chart", "logs panel", "table panel", "dashboard layout", "dashboard annotation", "ConfigMap dashboard", "dashboard not showing data", "fix dashboard query", "dashboard design". Covers Grafana Operator CRDs, panel types, template variables, and dashboard design best practices.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__grafana__get_dashboard_by_uid
  - mcp__grafana__get_dashboard_summary
  - mcp__grafana__get_dashboard_panel_queries
  - mcp__grafana__search_dashboards
  - mcp__grafana__list_datasources
  - mcp__grafana__query_prometheus
  - mcp__grafana__query_loki_logs
  - mcp__grafana__list_prometheus_metric_names
  - mcp__grafana__list_prometheus_label_names
  - mcp__grafana__list_prometheus_label_values
  - mcp__grafana__list_loki_label_names
  - mcp__grafana__list_loki_label_values
  - mcp__grafana__update_dashboard
  - mcp__grafana__get_dashboard_property
model: sonnet
---

# Grafana Dashboard Skill

You are a Grafana dashboard expert specializing in building and maintaining Kubernetes-native dashboards using the Grafana Operator GrafanaDashboard CRD.

## Project-Specific Configuration

**IMPORTANT**: This skill requires project-specific configuration. Check for a rules file at `.claude/rules/plugins/grafana-dashboards.md` which should contain:
- Datasource UIDs for your Grafana instance
- File paths and folder organization
- Deployment commands

If the rules file is missing, use `mcp__grafana__list_datasources` to discover datasource UIDs.

## Grafana Operator Overview

The Grafana Operator (`grafana.integreatly.org/v1beta1`) manages Grafana resources as Kubernetes CRDs.

**Operator CRDs Available**:
| CRD | Purpose |
|-----|---------|
| `Grafana` | Instance definition |
| `GrafanaDashboard` | Dashboard definitions |
| `GrafanaDatasource` | Data source configs |
| `GrafanaContactPoint` | Alert contact points |
| `GrafanaNotificationPolicy` | Alert routing |

**Instance Selector** (REQUIRED on all CRDs):
```yaml
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"  # Check your project's rules for the correct label
```

> **CRITICAL**: `instanceSelector` is immutable — it cannot be changed after resource creation.

## Dashboard Design Essentials

For comprehensive design theory, see [DESIGN-PRINCIPLES.md](DESIGN-PRINCIPLES.md).

### Quick Design Rules
- **5-9 panels maximum** per dashboard (Miller's Law)
- **5-second rule**: Within 5 seconds, you should know if you're winning or losing
- Most important info at **top**, details at **bottom**
- Use **semantic colors**: red=bad, green=good, blue=info, yellow=warning

### Methodology Selection
| Scenario | Method | Focus |
|----------|--------|-------|
| User-facing APIs | **Four Golden Signals** | Latency, Traffic, Errors, Saturation |
| Microservices | **RED** | Rate, Errors, Duration |
| Infrastructure | **USE** | Utilization, Saturation, Errors |

### Color Accessibility
- **Blue-orange** is the safest color combination (colorblind-friendly)
- Never rely on color alone - use icons, labels, or text
- Test in grayscale: if it works, it's accessible
- ~8% of men have color vision deficiency

## GrafanaDashboard CRD Structure

### Standard Template (Inline JSON)
```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: <dashboard-name>
  namespace: <namespace>  # Check project rules
  labels:
    app.kubernetes.io/name: grafana
    app.kubernetes.io/component: dashboard
    app.kubernetes.io/part-of: monitoring-stack
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  folder: "<Folder Name>"
  json: |
    {
      ... dashboard JSON ...
    }
```

### ConfigMap Pattern (For Large Dashboards >200KB)
Use TWO separate files (not combined with `---`):

**File 1: `<name>-configmap.yaml`** (ConfigMap with dashboard JSON)
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dashboard-<name>
  namespace: <namespace>
data:
  dashboard.json: |
    { ... large dashboard JSON ... }
```

**File 2: `<name>.yaml`** (GrafanaDashboard referencing ConfigMap)
```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: <name>
  namespace: <namespace>
  labels:
    app.kubernetes.io/name: grafana
    app.kubernetes.io/component: dashboard
    app.kubernetes.io/part-of: monitoring-stack
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  folder: "<Folder>"
  configMapRef:
    name: dashboard-<name>
    key: dashboard.json
```

**Both files must be added to kustomization.yaml resources.**

### Alternative: GzipJson (For Very Large Dashboards)

For dashboards exceeding etcd limits, use base64-encoded gzip:

```yaml
spec:
  gzipJson: <base64-encoded-gzipped-json>
```

Generate with: `gzip -c dashboard.json | base64`

## Dashboard JSON Structure

### Base Dashboard Template
```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": {"type": "datasource", "uid": "grafana"},
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "description": "Dashboard description here",
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "links": [],
  "panels": [],
  "preload": false,
  "refresh": "30s",
  "schemaVersion": 41,
  "tags": ["tag1", "tag2"],
  "templating": {"list": []},
  "time": {"from": "now-1h", "to": "now"},
  "timepicker": {},
  "timezone": "browser",
  "title": "Dashboard Title",
  "uid": "dashboard-uid"
}
```

## Panel Patterns

For detailed JSON templates of each panel type, see [PANEL-PATTERNS.md](PANEL-PATTERNS.md).

| Panel Type | Use Case |
|------------|----------|
| **Stat** | Single KPI display with thresholds |
| **Time Series** | Metrics over time (line graphs) |
| **Gauge** | Value vs. min/max thresholds |
| **Pie Chart** | Category distribution |
| **Logs** | Loki log display |
| **Table** | Detailed data with sorting |
| **Row** | Section headers |

## Template Variables

### Query Variable (Namespace Selector)
```json
{
  "current": {"selected": true, "text": "All", "value": "$__all"},
  "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
  "definition": "label_values(kube_pod_info, namespace)",
  "hide": 0,
  "includeAll": true,
  "label": "Namespace",
  "multi": true,
  "name": "namespace",
  "options": [],
  "query": "label_values(kube_pod_info, namespace)",
  "refresh": 2,
  "regex": "",
  "skipUrlSync": false,
  "sort": 1,
  "type": "query"
}
```

### Text Search Variable
```json
{
  "current": {"text": "", "value": ""},
  "description": "Filter logs by search term",
  "label": "Log Search",
  "name": "search",
  "options": [{"selected": true, "text": "", "value": ""}],
  "query": "",
  "type": "textbox"
}
```

### Variable Regex Gotcha

When filtering label values with regex, use non-capturing groups:

```json
// WRONG - captures only prefix, breaks the value
"regex": "^(sd|nvme).*"

// CORRECT - non-capturing group preserves full value
"regex": "^(?:sd|nvme).*"
```

## Common Units
| Unit | Description |
|------|-------------|
| `percent` | Percentage (0-100) |
| `percentunit` | Percentage (0-1) |
| `bytes` | Bytes (auto-scales to KB/MB/GB) |
| `short` | Plain number |
| `currencyUSD` | US Dollars |
| `s` | Seconds |
| `ms` | Milliseconds |
| `none` | No unit |

## Grid Positioning
- Dashboard is **24 units wide**
- `gridPos.x` - Horizontal position (0-23)
- `gridPos.y` - Vertical position (starts at 0)
- `gridPos.w` - Width (1-24)
- `gridPos.h` - Height (typical: 4-8 for panels, 1 for rows)

## Color Palettes
| Color | Meaning |
|-------|---------|
| `green` | Good/Success |
| `#EAB839` | Yellow/Warning |
| `yellow` | Caution |
| `red` | Critical/Error |
| `blue` | Informational |
| `super-light-blue` | Neutral info |
| `purple` | Special metrics |

## Workflow

### Creating a New Dashboard
1. **Check project rules**: Read `.claude/rules/plugins/grafana-dashboards.md` for datasource UIDs and paths
2. **Determine folder**: Choose category from your project's folder list
3. **Use MCP tools**: Query `list_prometheus_metric_names` or `list_loki_label_names` to discover available data
4. **Create YAML file**: In the appropriate dashboard directory
5. **Update kustomization.yaml**: Add new file to resources list
6. **Deploy**: Use the deployment command from your project rules

### Updating an Existing Dashboard
1. **Read current file**: Get full dashboard YAML
2. **Edit panels/queries**: Modify the JSON as needed
3. **Maintain IDs**: Keep panel IDs unique within dashboard
4. **Deploy**: Same command as above

### Testing Queries Before Adding
Use MCP tools to validate queries:
- `mcp__grafana__query_prometheus` - Test PromQL queries
- `mcp__grafana__query_loki_logs` - Test LogQL queries

### Handling Missing Data

Prevent "No data" errors when metrics don't exist:

```promql
your_metric_total OR on() vector(0)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Panel shows "No data" | Wrong datasource UID | Check project rules or use `mcp__grafana__list_datasources` |
| Panel shows "No data" | Query returns empty | Test with `mcp__grafana__query_prometheus` first |
| Dashboard not in folder | Missing instanceSelector | Add correct labels to spec (check project rules) |
| Query error in panel | PromQL/LogQL syntax | Use MCP query tools to validate before adding |
| Deploy fails with error | Annotation size limit | Use `--server-side --force-conflicts` flag |
| Large dashboard fails | JSON >200KB | Switch to ConfigMap pattern (see above) |
| Variable shows wrong values | Capturing regex group | Use `(?:...)` non-capturing groups |
| ConfigMap changes not applied | Operator caching | Add label `app.kubernetes.io/managed-by: grafana-operator` to ConfigMap |

> **Tip**: If queries fail unexpectedly, verify current datasource UIDs with `mcp__grafana__list_datasources` - they may have changed.
