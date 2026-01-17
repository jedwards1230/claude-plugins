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
- **Completed plans**: Status is "COMPLETE" or "DONE" → move to `archive/`
- **Old troubleshooting**: Resolved issues >6 months old → archive or summarize
- **Deprecated references**: Infrastructure that no longer exists → update or archive

### Consolidation
- **Duplicate notes**: Similar content in multiple files → merge (keep richer one)
- **Scattered topics**: 5+ notes on same topic in different folders → propose new category
- **Breadcrumb trail**: When consolidating, add: `> Consolidated from X, Y, Z on YYYY-MM-DD`

### Metadata & Organization
**Required frontmatter fields:**
```yaml
---
title: Human-readable title
type: note|plan|decision|troubleshooting|research|learning
permalink: folder/slug-based-on-title
tags:
  - relevant
  - tags
status: active|completed|deprecated  # Add if missing
---
```

**For archived items, add:**
```yaml
archived_date: YYYY-MM-DD
original_date: YYYY-MM-DD  # When originally created
```

### Content Quality
- **Fix broken links**: `memory://` links pointing to non-existent notes
- **Update stale info**: References to old infrastructure state
- **Historical context**: Preserve decision rationale and lessons learned

---

## Phase 3: Execute Changes

### Comprehensive Interactive Mode (no args)
- Full review of entire knowledge base
- Can make major restructuring changes
- Ask user for confirmation on significant changes
- Propose new category structures if patterns emerge

### Comprehensive CI Mode (--ci only)
- Full review of entire knowledge base
- Can make major restructuring changes
- **NEVER ask for confirmation** - proceed autonomously
- Make judgment calls based on the rules in this document
- Used by manual GitHub Action dispatch

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

### Moving Files to Archive
```bash
# Structure: archive/<original-folder>/<filename>.md
# Example: plans/My-Plan.md → archive/plans/My-Plan.md

git mv ".basic-memory/plans/My-Plan.md" ".basic-memory/archive/plans/My-Plan.md"
```

Before moving, update frontmatter:
```yaml
status: completed
archived_date: 2026-01-08
```

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

After completing maintenance, provide a summary:

```markdown
## Memory Maintenance Summary

**Mode:** [Comprehensive|Targeted|CI]
**Date:** YYYY-MM-DD

### Changes Made
- [ ] Archived: `plans/X.md` → Completed, moved to archive
- [ ] Updated: `infrastructure/Y.md` → Fixed broken links
- [ ] Consolidated: `A.md` + `B.md` → `C.md`

### Recommendations (requires human review)
- Consider archiving: `plans/Old-Plan.md` - appears complete but unclear
- Potential duplicate: `notes/X.md` and `notes/Y.md` overlap significantly

### Statistics
- Notes analyzed: X
- Notes modified: Y
- Notes archived: Z
- Broken links fixed: N
```

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
