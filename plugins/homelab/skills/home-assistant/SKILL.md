---
name: home-assistant
description: Use when interacting with Home Assistant — querying entity state, controlling devices, managing automations, helpers, areas, backups, or troubleshooting HA. Triggers on "home assistant", "hass", "turn on light", "check sensor", "automation", "helper", "HA backup", "entity state", "area", "device control", "scene", "script".
---

# Home Assistant

## MCP Access

Home Assistant is available via two MCP server entries on the proxy:

| Server | Endpoint | Purpose |
|--------|----------|---------|
| `home-assistant` | `mcp-lan.lilbro.cloud/home-assistant/mcp` | Full ha-mcp server (80+ tools) — entity management, automations, backups, HACS, services, config |
| `home-assistant-basic` | `mcp-lan.lilbro.cloud/home-assistant-basic/mcp` | Built-in HA MCP (`/api/mcp`) — voice-style controls (lights, media, fans, lists) |

Prefer `home-assistant` (ha-mcp) tools for all operations. Fall back to `home-assistant-basic` only if ha-mcp is unavailable.

## Before Making Changes

**Always get current state first.** Call `ha_get_overview` (minimal) to orient before any operation. For specific entities, use `ha_search_entities` or `ha_get_entity` to confirm current state and area assignment before modifying.

**Never do these without explicit user approval:**
- `ha_restart` — disrupts all automations, integrations, and connected services
- `ha_backup_restore` — replaces current state entirely
- `ha_remove_entity` — permanent, only use for confirmed stale/orphaned entities
- `ha_config_remove_automation` / `ha_config_remove_script` — destructive
- Modifying recorder, InfluxDB, HTTP, or HomeKit configuration (these are infrastructure-level)

## Kubernetes Deployment

- **Namespace**: `home-automation`
- **Image**: `ghcr.io/home-assistant/home-assistant:beta` (floating tag, beta channel)
- **Node**: linux-1 (`hostNetwork: true` for mDNS/device discovery)
- **Storage**: 20Gi Longhorn PVC (`homeassistant-config-longhorn`)
- **Database**: PostgreSQL via CloudNativePG (`homeassistant-pg`), backups to Garage S3
- **Secrets**: 1Password (`homeassistant-secrets`) mounted as `/config/secrets.yaml`
- **ArgoCD**: Manual sync (not auto-sync) to avoid disrupting automations
- **ha-mcp pod**: `ghcr.io/homeassistant-ai/ha-mcp:7.3` in same namespace, port 8086

## Configuration Sources

Some config is still Git-managed via ConfigMaps, some lives on the PVC:

| Source | What | Editable via MCP? |
|--------|------|-------------------|
| **ConfigMap** (`homeassistant-configuration`) | Main `configuration.yaml` — package includes | No (K8s manifest) |
| **ConfigMap** (`homeassistant-custom-package`) | HTTP trusted_proxies, recorder, InfluxDB, HomeKit, notify, template sensors | No (K8s manifest) |
| **ConfigMap** (`homeassistant-automations`) | Grafana alert automation | No (K8s manifest) |
| **ConfigMap** (`homeassistant-blueprints`) | Night light motion+lux blueprint | No (K8s manifest) |
| **PVC** (UI-managed) | Automations, scripts, scenes, helpers, dashboards, integrations | Yes |

## Backup Strategy

Three layers of protection:

1. **HA native backups** — `ha_backup_create` / `ha_backup_restore` for HA-level state
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
