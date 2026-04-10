---
name: wiki
description: >-
  Operating manual for AI agents interacting with the Home Wiki. Use when
  creating, editing, ingesting, searching, or maintaining wiki pages. Triggers:
  "update the wiki", "add to the wiki", "ingest into the wiki", "search the wiki",
  "create a wiki page", "wiki lint", "wiki schema", "log wiki activity",
  "wiki page", "write to wiki".
---

# Home Wiki

A shared Obsidian vault for organizational knowledge — homelab, projects,
recipes, research, guides. Accessible to all agents and family members.

- **Web UI**: https://wiki.lilbro.cloud
- **Schema**: **Always read before any wiki work** — `curl -s https://wiki.lilbro.cloud/meta/schema.md`

## Reading Content

| URL | Purpose |
|-----|---------|
| `wiki.lilbro.cloud/path.md` | Plain markdown (agent access) |
| `wiki.lilbro.cloud/path` | Rendered HTML (human links) |
| `wiki.lilbro.cloud/raw/path` | Native source files (PDFs, images, raw text) |

## Writing Content

All reads and writes go through the HTTP API or MCP tools.

### HTTP API (`wiki.lilbro.cloud/api/`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pages/{path}` | GET | Read a page |
| `/api/pages/{path}` | PUT | Create or update a page |
| `/api/pages/{path}` | PATCH | Partial find-and-replace edits |
| `/api/pages/{path}` | DELETE | Delete a page |
| `/api/pages` | GET | List pages (optional `?prefix=`) |
| `/api/search` | GET | Full-text search (`?q=&limit=&engine=`) |
| `/api/recent` | GET | Recently modified pages (`?limit=`) |
| `/api/directory` | GET | All pages with title/tags metadata |
| `/api/lint` | GET | Run mechanical lint checks |
| `/api/ingest` | GET | List unprocessed raw sources |
| `/api/log` | GET | Activity log |
| `/api/activity` | POST | Append activity entry |

### MCP Tools

Available via `mcp.lilbro.cloud/wiki/mcp`.

| Tool | Purpose |
|------|---------|
| `wiki_search` | Full-text search across wiki pages |
| `wiki_list_pages` | Browse all pages |
| `wiki_read_page` | Read a specific page |
| `wiki_create_page` | Create a new wiki page |
| `wiki_update_page` | Replace page content |
| `wiki_patch_page` | Partial page update (find-and-replace) |
| `wiki_delete_page` | Delete a page |
| `wiki_ingest` | List unprocessed raw sources |
| `wiki_ingest_generate` | AI-assisted ingestion of raw sources |
| `wiki_lint` | Check pages for mechanical issues |
| `wiki_lint_log` | Lint the activity log |
| `wiki_activity` | Log wiki operations |
| `wiki_log` | View activity log |
| `wiki_log_day` | View specific day's activity |
| `wiki_directory` | View page directory with metadata |
| `wiki_directory_generate` | Regenerate the directory index |
| `wiki_recent` | Recently modified pages |

## When to Use the Wiki

When knowledge is worth sharing beyond this repo or this machine — write it
to the wiki. Repo-local auto-memory is for repo-specific context (build
commands, tool paths, project patterns); the wiki is for everything else
(architecture decisions, research, investigations, guides).

## Referencing Wiki Content

- **To agents**: use `.md` suffix URLs for reads, API/MCP for writes
- **To user**: use web URLs (e.g., `https://wiki.lilbro.cloud/meta/schema`)
- **Raw sources**: always provide full URL with extension — raw files aren't
  in the Quartz sidebar, direct links are the only way to access them
