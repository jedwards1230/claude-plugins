# Panel Patterns

JSON templates for common Grafana panel types. Copy and modify these for your dashboards.

> **Note**: Replace `<PROMETHEUS_UID>` and `<LOKI_UID>` with your project's actual datasource UIDs. Check your project's `.claude/rules/plugins/grafana-dashboards.md` or use `mcp__grafana__list_datasources` to discover them.

## Stat Panel

Single KPI display with color thresholds.

```json
{
  "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
  "description": "Panel description",
  "fieldConfig": {
    "defaults": {
      "color": {"mode": "thresholds"},
      "thresholds": {
        "mode": "absolute",
        "steps": [
          {"color": "green", "value": null},
          {"color": "#EAB839", "value": 10},
          {"color": "red", "value": 50}
        ]
      },
      "unit": "currencyUSD"
    },
    "overrides": []
  },
  "gridPos": {"h": 4, "w": 4, "x": 0, "y": 1},
  "id": 1,
  "options": {
    "colorMode": "value",
    "graphMode": "area",
    "justifyMode": "auto",
    "orientation": "auto",
    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
    "showPercentChange": false,
    "textMode": "auto",
    "wideLayout": true
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
      "expr": "sum(your_metric_total)",
      "refId": "A"
    }
  ],
  "title": "Panel Title",
  "type": "stat"
}
```

## Time Series Panel

Metrics over time with line graphs.

```json
{
  "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
  "fieldConfig": {
    "defaults": {
      "color": {"mode": "palette-classic"},
      "custom": {
        "axisBorderShow": false,
        "axisCenteredZero": false,
        "axisColorMode": "text",
        "axisLabel": "",
        "axisPlacement": "auto",
        "barAlignment": 0,
        "barWidthFactor": 0.6,
        "drawStyle": "line",
        "fillOpacity": 0,
        "gradientMode": "none",
        "hideFrom": {"legend": false, "tooltip": false, "viz": false},
        "insertNulls": false,
        "lineInterpolation": "linear",
        "lineWidth": 1,
        "pointSize": 5,
        "scaleDistribution": {"type": "linear"},
        "showPoints": "never",
        "spanNulls": false,
        "stacking": {"group": "A", "mode": "none"},
        "thresholdsStyle": {"mode": "off"}
      },
      "links": [],
      "mappings": [],
      "thresholds": {
        "mode": "absolute",
        "steps": [
          {"color": "green", "value": 0},
          {"color": "red", "value": 80}
        ]
      },
      "unit": "short"
    },
    "overrides": []
  },
  "gridPos": {"h": 6, "w": 6, "x": 0, "y": 0},
  "id": 2,
  "options": {
    "legend": {"calcs": [], "displayMode": "list", "placement": "bottom", "showLegend": true},
    "tooltip": {"hideZeros": false, "mode": "single", "sort": "none"}
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
      "expr": "rate(metric_name[5m])",
      "format": "time_series",
      "intervalFactor": 2,
      "legendFormat": "{{label}}",
      "refId": "A"
    }
  ],
  "title": "Metric Over Time",
  "type": "timeseries"
}
```

## Pie Chart Panel

Category distribution as donut chart.

```json
{
  "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
  "description": "Distribution description",
  "fieldConfig": {
    "defaults": {
      "color": {"mode": "palette-classic"},
      "custom": {"hideFrom": {"legend": false, "tooltip": false, "viz": false}},
      "mappings": [],
      "unit": "currencyUSD"
    },
    "overrides": []
  },
  "gridPos": {"h": 8, "w": 5, "x": 14, "y": 6},
  "id": 11,
  "options": {
    "legend": {"displayMode": "list", "placement": "bottom", "showLegend": true, "values": ["percent"]},
    "pieType": "donut",
    "reduceOptions": {"calcs": ["sum"], "fields": "", "values": false},
    "tooltip": {"mode": "single", "sort": "none"}
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
      "expr": "sum by (label) (increase(metric_total[$__range]))",
      "legendFormat": "{{label}}",
      "refId": "A"
    }
  ],
  "title": "By Category",
  "type": "piechart"
}
```

## Gauge Panel

Value display against min/max thresholds.

```json
{
  "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
  "fieldConfig": {
    "defaults": {
      "color": {"mode": "thresholds"},
      "mappings": [],
      "max": 10,
      "min": 0,
      "thresholds": {
        "mode": "absolute",
        "steps": [
          {"color": "blue", "value": 0},
          {"color": "green", "value": 1},
          {"color": "yellow", "value": 8},
          {"color": "red", "value": 10}
        ]
      },
      "unit": "none"
    },
    "overrides": []
  },
  "gridPos": {"h": 5, "w": 6, "x": 0, "y": 6},
  "id": 6,
  "options": {
    "minVizHeight": 75,
    "minVizWidth": 75,
    "orientation": "auto",
    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
    "showThresholdLabels": false,
    "showThresholdMarkers": true,
    "sizing": "auto"
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "prometheus", "uid": "<PROMETHEUS_UID>"},
      "expr": "metric_count",
      "legendFormat": "Label",
      "refId": "A"
    }
  ],
  "title": "Gauge Title",
  "type": "gauge"
}
```

## Logs Panel (Loki)

Display logs from Loki datasource.

```json
{
  "datasource": {"type": "loki", "uid": "<LOKI_UID>"},
  "fieldConfig": {"defaults": {}, "overrides": []},
  "gridPos": {"h": 10, "w": 24, "x": 0, "y": 12},
  "id": 10,
  "options": {
    "dedupStrategy": "none",
    "enableInfiniteScrolling": false,
    "enableLogDetails": true,
    "prettifyLogMessage": false,
    "showCommonLabels": false,
    "showLabels": false,
    "showTime": true,
    "sortOrder": "Descending",
    "wrapLogMessage": false
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "loki", "uid": "<LOKI_UID>"},
      "expr": "{namespace=\"$namespace\", container=\"$container\"} |= \"$search\"",
      "legendFormat": "",
      "refId": "A"
    }
  ],
  "title": "Logs",
  "type": "logs"
}
```

## Table Panel

Detailed data display with sorting and overrides.

```json
{
  "datasource": {"type": "loki", "uid": "<LOKI_UID>"},
  "fieldConfig": {
    "defaults": {
      "color": {"mode": "palette-classic-by-name"},
      "custom": {"align": "auto", "cellOptions": {"type": "auto"}, "filterable": false, "inspect": false},
      "mappings": [],
      "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}]},
      "unit": "short"
    },
    "overrides": [
      {
        "matcher": {"id": "byName", "options": "Value"},
        "properties": [
          {"id": "custom.cellOptions", "value": {"mode": "gradient", "type": "gauge", "valueDisplayMode": "text"}},
          {"id": "custom.width", "value": 400}
        ]
      }
    ]
  },
  "gridPos": {"h": 10, "w": 12, "x": 0, "y": 30},
  "id": 20,
  "options": {
    "cellHeight": "sm",
    "footer": {"countRows": false, "enablePagination": false, "fields": "", "reducer": ["sum"], "show": false},
    "showHeader": true,
    "sortBy": [{"desc": true, "displayName": "Value"}]
  },
  "pluginVersion": "12.1.0",
  "targets": [
    {
      "datasource": {"type": "loki", "uid": "<LOKI_UID>"},
      "expr": "topk(15, sum by (label) (count_over_time({service_name=\"app\"} |= \"event\" | json [$__range])))",
      "legendFormat": "{{label}}",
      "refId": "A"
    }
  ],
  "title": "Table Title",
  "transformations": [
    {"id": "reduce", "options": {"includeTimeField": false, "mode": "reduceFields", "reducers": ["sum"]}},
    {"id": "sortBy", "options": {"fields": {}, "sort": [{"field": "Value", "desc": true}]}}
  ],
  "type": "table"
}
```

## Row Panel (Section Header)

Collapsible section header for organizing panels.

```json
{
  "collapsed": false,
  "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
  "id": 100,
  "panels": [],
  "title": "Section Name",
  "type": "row"
}
```

## Datasource Variable (Recommended)

Instead of hardcoding datasource UIDs, use a datasource template variable:

```json
{
  "current": {},
  "hide": 0,
  "includeAll": false,
  "label": "Datasource",
  "multi": false,
  "name": "datasource",
  "options": [],
  "query": "prometheus",
  "queryValue": "",
  "refresh": 1,
  "regex": "",
  "skipUrlSync": false,
  "type": "datasource"
}
```

Then reference it in panels:
```json
"datasource": {"type": "prometheus", "uid": "$datasource"}
```

This makes dashboards portable across Grafana instances.
