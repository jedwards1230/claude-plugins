---
name: home-assistant
description: Use when interacting with Home Assistant — controlling devices (lights, switches, fans, locks, covers, climate, media players, vacuums, cameras), querying sensors (temperature, humidity, power, energy, motion, doors, windows), managing automations, scripts, scenes, helpers, areas, floors, labels, dashboards, backups, HACS, or troubleshooting HA integrations. Also triggers for smart home control by room ("turn off living room lights", "set bedroom to 72", "what's on in the kitchen"), sensor queries ("what's the temperature", "is the door open", "energy usage", "motion detected"), history ("when did X happen", "temperature last week"), protocol-level work (Zigbee, Z-Wave, MQTT, Matter, Thread, HomeKit), and dashboard management (Lovelace, cards, views). Triggers on "home assistant", "hass", "HA", "smart home", "turn on", "turn off", "set temperature", "brightness", "sensor", "automation", "helper", "backup", "entity", "area", "device", "scene", "script", "dashboard", "Lovelace", "HACS", "integration", "blueprint".
---

# Home Assistant

## MCP Access

Home Assistant tools are available via the `home-assistant` MCP server at `mcp.lilbro.cloud/home-assistant/mcp`. Tools are prefixed `mcp__home-assistant__ha_*`.

## Before Making Changes

**Always get current state first.** Call `ha_get_overview` (minimal) to orient — it returns area list, entity counts by domain, active automations, and system info (version, timezone, running state). For specific entities, use `ha_search_entities` (supports domain and area filters) or `ha_get_entity` (full registry detail including area, labels, platform) to confirm state before modifying.

**All HA write operations require explicit user approval.** Changes take effect immediately on a live home — present your planned changes and wait for confirmation before calling any `set`, `remove`, or `create` tool. This includes automations, scripts, helpers, dashboards, entities, areas, labels, and service calls that modify state.

**Especially dangerous — always confirm with extra care:**
- `ha_restart` — disrupts all automations, integrations, and connected services
- `ha_backup_restore` — replaces current state entirely
- `ha_remove_entity` / `ha_remove_device` — permanent, only for confirmed stale/orphaned entries
- `ha_config_remove_automation` / `ha_config_remove_script` — destructive
- Modifying recorder, InfluxDB, HTTP, or HomeKit configuration (infrastructure-level, Git-managed)

## Tool Quick Reference

| Task | Tool | Notes |
|------|------|-------|
| **Orient / overview** | `ha_get_overview` | Areas, entity counts, system info. Use `minimal` detail level |
| **Find entities** | `ha_search_entities` | Filter by `domain_filter`, `area_filter`, name pattern |
| **Entity registry detail** | `ha_get_entity` | Area, labels, platform, device_id. Accepts list for bulk |
| **Current state/attributes** | `ha_get_state` | On/off, temperature, brightness. Accepts list for bulk |
| **Control any device** | `ha_call_service` | Universal: `domain`, `service`, `entity_id`, `data` |
| **Bulk device control** | `ha_bulk_control` | Multiple operations in parallel |
| **History** | `ha_get_history` | `source="history"` (raw, ~10d) or `source="statistics"` (aggregated, permanent) |
| **Logs** | `ha_get_logs` | Sources: logbook, system, error_log |
| **Entity management** | `ha_set_entity` | Rename, area assign, labels, icon, enable/disable, voice exposure |
| **Remove entity** | `ha_remove_entity` | Permanent — prefer `ha_set_entity(enabled=False)` |
| **Device info** | `ha_get_device` | Filter by area, integration (zha, zigbee2mqtt, zwave_js) |
| **Automations** | `ha_config_get_automation`, `ha_config_set_automation` | Get/create/update. Set supports `python_transform` for edits |
| **Automation traces** | `ha_get_automation_traces` | Debug what triggered, conditions, actions, errors |
| **Scripts** | `ha_config_get_script`, `ha_config_set_script` | Same pattern as automations |
| **Helpers (simple)** | `ha_config_set_helper` | input_boolean, input_number, counter, timer, schedule, zone, person |
| **Helpers (advanced)** | `ha_set_config_entry_helper` | template, group, utility_meter, min_max, threshold, derivative |
| **Helper schema** | `ha_get_helper_schema` | Discover required fields before creating |
| **Areas / Floors** | `ha_config_list_areas`, `ha_config_set_area`, `ha_config_list_floors` | Room organization |
| **Labels / Categories** | `ha_config_set_label`, `ha_config_set_category` | Tagging and organization |
| **Groups** | `ha_config_set_group`, `ha_config_list_groups` | Old-style entity groups |
| **Dashboards** | `ha_config_get_dashboard`, `ha_config_set_dashboard` | Lovelace management. Set supports `python_transform` |
| **Dashboard resources** | `ha_config_set_dashboard_resource` | Custom cards (inline or URL) |
| **Scenes** | Search via `ha_search_entities(domain_filter="scene")` | Scenes are entities |
| **Calendars** | `ha_config_get_calendar_events`, `ha_config_set_calendar_event` | Read/create events |
| **Todo lists** | `ha_get_todo`, `ha_set_todo_item`, `ha_remove_todo_item` | Shopping list, tasks |
| **Blueprints** | `ha_get_blueprint`, `ha_import_blueprint` | List/import automation blueprints |
| **HACS** | `ha_hacs_search`, `ha_hacs_download`, `ha_hacs_repository_info` | Custom integrations and cards |
| **Templates** | `ha_eval_template` | Test Jinja2 expressions against live state |
| **Services** | `ha_list_services` | Discover available services by domain |
| **Deep search** | `ha_deep_search` | Search inside automation/script/dashboard configs |
| **System health** | `ha_get_system_health` | Includes Zigbee/Z-Wave network diagnostics |
| **Config check** | `ha_check_config` | Validate before restart |
| **Reload** | `ha_reload_core` | Reload automations/scripts/etc without restart |
| **Backups** | `ha_backup_create`, `ha_backup_restore` | HA-level backup (excludes DB for speed) |
| **Updates** | `ha_get_updates` | Available updates for HA core, add-ons, HACS, firmware |
| **Camera** | `ha_get_camera_image` | Snapshot from camera entity |
| **Restart** | `ha_restart` | Full restart — always `ha_check_config` first. **Requires user approval** |

## Kubernetes Deployment

- **Namespace**: `home-automation`
- **Node**: linux-1 (`hostNetwork: true` for mDNS/device discovery)
- **Storage**: 20Gi Longhorn PVC (`homeassistant-config-longhorn`)
- **Database**: PostgreSQL via CloudNativePG (`homeassistant-pg`), backups to Garage S3
- **Secrets**: 1Password (`homeassistant-secrets`) mounted as `/config/secrets.yaml`
- **ArgoCD**: Manual sync (not auto-sync) to avoid disrupting automations
- **ha-mcp pod**: `ghcr.io/homeassistant-ai/ha-mcp` in same namespace, port 8086

## Configuration Sources

Some config is Git-managed via ConfigMaps, some lives on the PVC:

| Source | What | Editable via MCP? |
|--------|------|-------------------|
| **ConfigMap** (`homeassistant-configuration`) | Main `configuration.yaml` — package includes | No (K8s manifest) |
| **ConfigMap** (`homeassistant-custom-package`) | HTTP trusted_proxies, recorder, InfluxDB, HomeKit, notify, template sensors | No (K8s manifest) |
| **ConfigMap** (`homeassistant-blueprints`) | Night light motion+lux blueprint | No (K8s manifest) |
| **PVC** (UI-managed) | Automations, scripts, scenes, helpers, dashboards, integrations | Yes |

## Backup Strategy

Three layers of protection:

1. **HA native backups** — `ha_backup_create` for fast config-only backup (excludes DB). Use before destructive operations
2. **Velero** — Longhorn PVC snapshots (daily-critical + weekly-full schedules)
3. **CNPG** — PostgreSQL database backups to Garage S3 (daily at 2 AM)

## Connected Services

These services depend on or integrate with Home Assistant:

| Service | Protocol | Impact if HA is down |
|---------|----------|---------------------|
| Zigbee2mqtt | MQTT via Mosquitto | Zigbee devices lose automation |
| Z-Wave JS UI | WebSocket | Z-Wave devices lose automation |
| Frigate | HTTP API | Camera detection events stop |
| Scrypted | HomeKit bridge | Apple Home loses camera feeds |
| Music Assistant | HA integration | Multi-room audio control lost |
| InfluxDB | HTTP push | Long-term metrics stop recording |
| Matter/Thread (OTBR) | IPv6 link-local | Thread devices lose cloud control |
