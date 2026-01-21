---
name: dream
description: "Maintain and optimize basic-memory knowledge base. Use --ci for automated diff-targeted mode (GitHub Actions)."
argument-hint: "[--ci]"
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

| Mode | Args | Behavior |
|------|------|----------|
| **Comprehensive** | (none) | Full KB review - scan EVERY file, major changes OK, interactive |
| **CI** | `--ci` | Diff-targeted, non-interactive, conservative changes only |

**Key behaviors:**
- **No flags (comprehensive)**: Scan ALL files in `.basic-memory/`, fix everything found, can ask user questions
- **`--ci` flag**: Only examine files changed in recent git commits, never ask questions, conservative

**GitHub Actions uses:**
- Scheduled (nightly): `--ci` → quick scan of recent changes only
- Manual dispatch: (no flags) → comprehensive review of entire KB

---

## Phase 1: Gather Context

### CI Mode (--ci)
Quick targeted scan - only recent changes:

```bash
# Get files changed in last 20 commits
git log --oneline --name-only -20 -- .basic-memory/ | grep "\.md$" | sort -u
```

Then use basic-memory MCP to read those specific files.

### Comprehensive Mode (no flags)
**CRITICAL: You MUST scan every single file.** Do not skip files or sample.

**Step 1: Get complete file inventory**
```
mcp__basic-memory__list_directory(dir_name="/", depth=5)
```

**Step 2: Systematically process EVERY folder**

Process each folder in order, reading and evaluating EVERY file:

1. `.basic-memory/plans/` - Check status, archive completed
2. `.basic-memory/archive/` - Verify metadata, fix issues
3. `.basic-memory/troubleshooting/` - Archive resolved issues >6 months old
4. `.basic-memory/decisions/` - Preserve all, fix metadata only
5. `.basic-memory/learnings/` - Fix metadata
6. `.basic-memory/research/` - Check for stale content
7. `.basic-memory/homelab/` - Fix broken links, update stale refs
8. `.basic-memory/infrastructure/` - Fix broken links
9. `.basic-memory/home-automation/` - Fix metadata
10. `.basic-memory/networking/` - Fix metadata
11. `.basic-memory/monitoring/` - Fix metadata
12. `.basic-memory/kubernetes/` - Fix metadata
13. `.basic-memory/migrations/` - Archive completed
14. `.basic-memory/security/` - Fix metadata
15. `.basic-memory/debugging/` - Archive resolved
16. All other folders found in step 1

**Step 3: For EACH file, check:**
- [ ] Frontmatter has required fields (title, type, permalink, tags)
- [ ] `type` matches content (plan vs note vs decision, etc.)
- [ ] Status in frontmatter field, not in tags
- [ ] Type not duplicated in tags
- [ ] All `memory://` links resolve to existing files
- [ ] Plans have `status:` field with appropriate value
- [ ] Completed items should be archived

**Step 4: Search for issues**
```
mcp__basic-memory__search_notes(query="status:completed")
mcp__basic-memory__search_notes(query="TODO OR FIXME OR outdated")
```

**YOU MUST report how many files you examined in the final summary.**

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

### Comprehensive Mode (no flags)
- **Full review of ENTIRE knowledge base** - every file must be examined
- Can make major restructuring changes
- Can ask user for confirmation on significant changes
- Propose new category structures if patterns emerge
- **Must report total files examined vs modified**

### CI Mode (--ci)
- **Diff-targeted only** - examine files changed in recent git commits
- **NEVER ask for confirmation** - proceed autonomously
- **Conservative changes only**:
  - Fix broken links
  - Fix metadata issues (wrong type, missing required fields)
  - Archive ONLY items explicitly marked "completed" or "done"
- Skip anything requiring human judgment
- Make safe assumptions or skip uncertain cases

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

After completing maintenance, provide a **detailed** summary:

```markdown
## Claude Dream Summary

**Mode:** [Comprehensive|CI]
**Date:** YYYY-MM-DD

### Statistics
| Metric | Count |
|--------|-------|
| Total files in KB | X |
| Files examined | Y |
| Files modified | Z |
| Files archived | N |
| Metadata issues fixed | N |
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

### Files Examined But Not Modified
- X files with valid metadata and current content
```

**Important**:
- In comprehensive mode, "Files examined" should equal "Total files in KB"
- In CI mode, this summary should be detailed enough to serve as the PR body

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

**Begin by detecting the mode from arguments, then follow the appropriate phase 1 instructions.**
