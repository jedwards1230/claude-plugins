---
name: dream
description: "Maintain and optimize basic-memory knowledge base. Use --diff for git-targeted review, --ci for conservative non-interactive mode (GitHub Actions)."
argument-hint: "[--diff] [--ci]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git mv:*)
  - Bash(git add:*)
  - Bash(mkdir:*)
  - mcp__basic-memory__*
example_prompts:
  - "review and maintain memories"
  - "prune and tune the knowledge base"
  - "memory maintenance"
  - "dreaming"
---

# Basic-Memory Knowledge Base Maintenance

You are performing knowledge base maintenance ("dreaming") for the `.basic-memory/` directory. This is Claude's memory - you own these files completely. They are committed to git but not touched by human developers.

## Mode Detection

Parse arguments from `$ARGUMENTS`:

| Mode                          | Args          | Behavior                                             |
| ----------------------------- | ------------- | ---------------------------------------------------- |
| **Comprehensive Interactive** | (none)        | Full KB review, interactive, major changes OK        |
| **Comprehensive CI**          | `--ci`        | Full KB review, non-interactive, major changes OK    |
| **Targeted**                  | `--diff`      | Focus on recent git changes only                     |
| **CI/Conservative**           | `--ci --diff` | Non-interactive, diff-targeted, conservative changes |

**Key flags:**
- `--ci` = Non-interactive (never ask questions, proceed autonomously)
- `--diff` = Diff-targeted scope (only files changed in recent git commits)

**GitHub Actions uses:**
- Scheduled (nightly): `--ci --diff` → conservative, only recent changes
- Manual dispatch: `--ci` → comprehensive but non-interactive

---

## Phase 1: Gather Context

Use basic-memory MCP tools (NOT raw file reads) for efficiency:

```
1. List all notes and structure:
   mcp__basic-memory__list_directory(dir_name="/", depth=3)

2. Get recent activity:
   mcp__basic-memory__recent_activity(timeframe="7d")

3. If --diff mode, also check git:
   git log --oneline --name-status -20 -- .basic-memory/
```

For comprehensive mode, also search for potential issues:
```
mcp__basic-memory__search_notes(query="status:completed OR deprecated")
mcp__basic-memory__search_notes(query="TODO OR FIXME OR outdated")
```

---

## Phase 2: Identify Maintenance Opportunities

### Pruning & Archiving

**When to archive** (move to `archive/<original-folder>/`):
- Status explicitly says "completed", "done", or "archived"
- Resolved troubleshooting issues >6 months old
- Deprecated references to infrastructure that no longer exists
- Plans where all objectives are marked complete

**Never archive**:
- Notes with `status: active` or `status: in-progress`
- Reference documentation still in use
- Decision logs (preserve for historical context)
- Notes actively linked by other documents

**Archive process**:
```bash
# Structure: archive/<original-folder>/<filename>.md
git mv ".basic-memory/plans/My-Plan.md" ".basic-memory/archive/plans/My-Plan.md"
```

Before moving, update frontmatter:
```yaml
status: completed
archived_date: 2026-01-20
original_date: 2025-06-15  # When originally created
```

### Consolidation
- **Duplicate notes**: Similar content in multiple files → merge (keep richer one)
- **Scattered topics**: 5+ notes on same topic in different folders → propose new category
- **Breadcrumb trail**: When consolidating, add: `> Consolidated from X, Y, Z on YYYY-MM-DD`

### Frontmatter Standards

**Required fields** - every note MUST have:

| Field | Values | Description |
|-------|--------|-------------|
| `title` | String | Human-readable title |
| `type` | `note`, `plan`, `decision`, `troubleshooting`, `research`, `learning` | Document classification |
| `permalink` | `folder/slug-based-on-title` | Stable identifier (lowercase, hyphens) |
| `tags` | YAML array | Categorization (min 1 tag) |

**Optional fields**:

| Field | Values | When to use |
|-------|--------|-------------|
| `status` | `active`, `in-progress`, `completed`, `paused`, `deprecated` | Plans/projects with lifecycle |
| `archived_date` | `YYYY-MM-DD` | When moved to archive/ |
| `original_date` | `YYYY-MM-DD` | Original creation date (archived items) |

**Example valid frontmatter**:
```yaml
---
title: Longhorn Storage Setup Plan
type: plan
permalink: plans/longhorn-storage-setup-plan
tags:
- longhorn
- storage
- kubernetes
status: in-progress
---
```

### Anti-Patterns to Fix

| Issue | Fix |
|-------|-----|
| `type: note` on a plan file | Change to `type: plan` |
| Status in tags (`- complete`, `- in-progress`) | Remove from tags, add `status:` field |
| Type in tags (`- plan`, `- implementation-plan`) | Remove, use `type:` field instead |
| Missing `status:` on plans | Add appropriate status based on content |
| Broken `memory://` links | Fix path or remove if target doesn't exist |
| Duplicate content across files | Consolidate into richer version, archive other |

### Content Quality & Links

**Link formats**:
- Internal: `[Link Text](memory://folder/note-permalink)`
- Wiki-style: `[[Note Title]]`
- Relative: `[Link Text](./sibling-note.md)`

**Quality checks**:
- Fix broken `memory://` links pointing to non-existent or moved notes
- Update stale infrastructure references
- Preserve decision rationale and lessons learned
- Add historical context breadcrumbs when consolidating

---

## Phase 3: Execute Changes

### Comprehensive Interactive Mode (no args)
- Full review of entire knowledge base
- Can make major restructuring changes
- Ask user for confirmation on significant changes
- Propose new category structures if patterns emerge

### Comprehensive CI Mode (--ci only)
- Full review of **entire** knowledge base - examine every file
- Can make major restructuring changes
- **NEVER ask for confirmation** - proceed autonomously
- Make judgment calls based on the rules in this document
- Used by manual GitHub Action dispatch

**Comprehensive mode MUST**:
1. Scan ALL notes in `.basic-memory/` (not just recent)
2. Fix ALL metadata issues found (wrong type, missing status, status in tags)
3. Archive ALL clearly completed plans
4. Identify and consolidate duplicates
5. Fix ALL broken memory:// links
6. Produce a detailed summary with every change documented

### Targeted Mode (--diff)
- Focus only on recently changed files
- Moderate changes - cleanup related to recent work
- Don't restructure unrelated areas

### CI/Conservative Mode (--ci --diff)
- **Conservative only** - no major restructuring
- Safe changes: fix broken links, update metadata, archive obviously complete items
- Skip anything that needs human judgment
- Don't ask questions - make safe assumptions or skip
- Used by nightly scheduled GitHub Action

---

## Execution Guidelines

### Editing Notes
Use MCP tools when possible:
```
mcp__basic-memory__edit_note(
  identifier="plans/my-plan",
  operation="replace_section",
  section="Status",
  content="## Status\n\n**COMPLETED** - Archived on 2026-01-08"
)
```

Or use Edit tool for precise changes to the markdown files directly.

### Creating Categories
When proposing new categories:
1. Identify 5+ related notes scattered across folders
2. Create new folder under `.basic-memory/`
3. Move related notes (preserving as much history as practical)
4. Update any `memory://` links that reference moved files

---

## Output Summary

After completing maintenance, provide a **detailed** summary suitable for PR bodies:

```markdown
## Claude Dream Summary

**Mode:** [Comprehensive|Targeted|CI]
**Date:** YYYY-MM-DD

### Statistics
| Metric | Count |
|--------|-------|
| Notes analyzed | X |
| Notes modified | Y |
| Notes archived | Z |
| Metadata fixed | N |
| Broken links fixed | N |
| Duplicates consolidated | N |

### Changes Made

#### Archived (moved to archive/)
| File | Reason |
|------|--------|
| `plans/X.md` | Status: completed, moved to archive/plans/ |

#### Metadata Fixed
| File | Change |
|------|--------|
| `plans/Y.md` | Added `status: active`, changed `type: note` → `type: plan` |
| `infrastructure/Z.md` | Removed status from tags, added `status:` field |

#### Content Updated
| File | Change |
|------|--------|
| `infrastructure/Y.md` | Fixed 3 broken memory:// links |
| `homelab/X.md` | Added historical context breadcrumb |

#### Consolidated
| Source Files | Target | Reason |
|--------------|--------|--------|
| `A.md` + `B.md` | `C.md` | Duplicate content, kept richer version |

### Recommendations (requires human review)
- **Consider archiving**: `plans/Old-Plan.md` - appears complete but status unclear
- **Potential duplicate**: `notes/X.md` and `notes/Y.md` overlap significantly
- **Needs attention**: `research/Stale.md` - references outdated infrastructure

### Files Skipped (no changes needed)
- X files with valid metadata
- Y files recently modified (within 7 days)
```

**Important**: In CI mode, this summary should be detailed enough to serve as the PR body. Include every change with reasoning.

---

## Safety Rules

1. **Never delete files** - always archive instead
2. **Preserve history** - keep breadcrumbs when consolidating
3. **Conservative by default** - when unsure, skip or ask (except in CI mode)
4. **Respect active work** - don't archive anything without clear "completed" status
5. **Maintain links** - update `memory://` references when moving files
6. **Path validation** - all operations must target `.basic-memory/` directory
   - Source paths must start with `.basic-memory/`
   - Destination paths must start with `.basic-memory/`
   - No path traversal (`..`) allowed
7. **Focus scope** - primarily modify `.basic-memory/` files; only touch other files (like docs/) if directly relevant and justified

---

**Begin by detecting the mode from arguments and gathering context with MCP tools.**
