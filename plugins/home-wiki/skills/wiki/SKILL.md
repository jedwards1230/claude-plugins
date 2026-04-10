---
name: wiki
description: >-
  Operating manual for AI agents interacting with the Home Wiki. Use when
  creating, editing, ingesting, searching, or maintaining wiki pages. Triggers:
  "update the wiki", "add to the wiki", "ingest into the wiki", "search the wiki",
  "create a wiki page", "wiki lint", "wiki schema", "log wiki activity",
  "wiki page", "write to wiki".
---

# Home Wiki Agent Manual

The Home Wiki is a shared Obsidian vault for organizational knowledge -- homelab,
projects, recipes, research, guides. Accessible to all agents and family members.

- **Web UI**: https://wiki.lilbro.cloud
- **Schema**: Always read before any wiki work -- `wiki.lilbro.cloud/meta/schema.md`

## Access Patterns

| Method | URL/Tool | Use |
|--------|----------|-----|
| MCP tools | `wiki_*` tools (auto-configured by this plugin) | Primary agent interface |
| Plain markdown | `wiki.lilbro.cloud/path.md` | Token-efficient reads via WebFetch |
| HTML | `wiki.lilbro.cloud/path` | Human-readable links |
| Raw files | `wiki.lilbro.cloud/raw/path` | Source documents, PDFs, images |

## Principles

1. **Metadata over structure.** Tags and frontmatter organize -- not folders.
2. **Human-readable, agent-maintained.** Pages read like a person wrote them.
3. **Compile, don't copy.** Synthesize sources into cross-referenced wiki pages.
4. **Link liberally.** Every concept mention should be a wikilink `[[like-this]]`.
5. **Small, focused pages.** 300-800 words. Split beyond 1,000.

## Required Frontmatter

Every wiki page must have:

```yaml
---
title: Page Title
tags:
  - domain-tag
date: 2026-04-06
---
```

Optional: `description:` (under 100 chars), `source:` (url:/repo:/vault: prefix), `status:` (stub|wip|complete).

## Tag Domains

| Domain | Use for |
|--------|---------|
| `homelab` | Infrastructure, services, cluster |
| `research` | Academic/reference knowledge |
| `project` | Active development work |
| `food` | Recipes, meal prep, cooking |
| `guide` | How-to for family/future reference |
| `reference` | Books, tools, places |
| `career` | Professional development |
| `meta` | Wiki operations, schema |

## Naming Conventions

- Kebab-case filenames: `home-assistant.md`
- Title case in `title` frontmatter
- No `# H1` headings (Quartz renders the title from frontmatter)
- Wikilinks: `[[page-name]]` or `[[page-name|Display Text]]`

## Activity Logging

After any wiki operation, log via `wiki_activity` MCP tool or `POST /api/activity`.
Two-tier system: daily files at `meta/activity/YYYY-MM-DD.md` and an index at `meta/log.md`.

## Key MCP Tools

| Tool | Purpose |
|------|---------|
| `wiki_search` | Full-text search across wiki pages |
| `wiki_list_pages` | Browse all pages |
| `wiki_read_page` | Read a specific page |
| `wiki_create_page` | Create a new wiki page |
| `wiki_update_page` | Replace page content |
| `wiki_patch_page` | Partial page update (find-and-replace) |
| `wiki_ingest` | List unprocessed raw sources |
| `wiki_ingest_generate` | AI-assisted ingestion of raw sources |
| `wiki_lint` | Check pages for mechanical issues |
| `wiki_activity` | Log wiki operations |
| `wiki_log` | View activity log |
| `wiki_log_day` | View specific day's activity |
| `wiki_directory` | View page directory with metadata |
| `wiki_directory_generate` | Regenerate the directory index |
| `wiki_recent` | Recently modified pages |

## Referencing Wiki Content

- **To agents**: use `.md` suffix URLs for reads, MCP tools for writes
- **To user**: use web URLs (e.g., `https://wiki.lilbro.cloud/meta/schema`)
- **Raw sources**: always provide full URL with extension

For the complete, canonical schema: `wiki.lilbro.cloud/meta/schema.md`
