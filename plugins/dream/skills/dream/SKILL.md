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
  - "run memory dreaming"
  - "clean up basic-memory"
  - "archive completed plans"
---

# Basic-Memory Knowledge Base Maintenance

You are performing knowledge base maintenance ("dreaming") for the `.basic-memory/` directory. This is Claude's memory - you own these files completely. They are committed to git but not touched by human developers.

## Current Knowledge Base State (Injected)

**Basic Memory Project Info:**
```
!`basic-memory project info default`
```

**Directory structure:**
```
!`find .basic-memory -type d`
```

**File count:**
```
!`find .basic-memory -name *.md | wc -l`
```

**Recent git changes:**
```
!`git log --oneline -20 -- .basic-memory/`
```

---

## Mode Detection

Parse arguments from `$ARGUMENTS` (auto-populated from command invocation, e.g., `/dream --ci`):

| Mode | Args | Behavior |
|------|------|----------|
| **Comprehensive** | (none) | Full KB review - scan EVERY file, major changes OK, interactive |
| **CI** | `--ci` | Diff-targeted, non-interactive, conservative changes only |

**Key behaviors:**
- **No flags (comprehensive)**: Scan ALL entities shown above, fix everything found, can ask user questions
- **`--ci` flag**: Only examine files from "Recent git changes" section, never ask questions, conservative

**GitHub Actions uses:**
- Scheduled (nightly): `--ci` → quick scan of recent changes only
- Manual dispatch: (no flags) → comprehensive review of entire KB

---

## Phase 1: Gather Context

### CI Mode (--ci)
Process ONLY the files listed in "Recent git changes" above. Skip all other files.

### Comprehensive Mode (no flags)
**CRITICAL: You MUST process every entity.** The count is shown in "Basic Memory Project Info" above (Entities row). Your final summary MUST match this number.

**Key metrics to fix from the injected stats:**
- **Unresolved Relations** - These are broken `memory://` links that need fixing
- **Entity Types** - Most show as `note` but many should be `plan`, `troubleshooting`, etc.

**Step 1: Process each folder systematically**

For each folder shown in "Directory structure" above, read and evaluate EVERY `.md` file:

| Folder | Expected Type | Action |
|--------|---------------|--------|
| `plans/` | `type: plan` | Check status, archive completed |
| `archive/` | varies | Verify metadata, fix issues |
| `troubleshooting/` | `type: troubleshooting` | Archive resolved issues >6 months old |
| `decisions/` | `type: decision` | Preserve all, fix metadata only |
| `learnings/` | `type: learning` | Fix metadata |
| `research/` | `type: research` | Check for stale content |
| All other folders | `type: note` | Fix broken links, metadata |

**Step 2: For EACH file, check:**
- [ ] Frontmatter has required fields (title, type, permalink, tags)
- [ ] `type` matches folder (see table above)
- [ ] Status in frontmatter field, not in tags
- [ ] Type not duplicated in tags
- [ ] All `memory://` links resolve to existing files
- [ ] Plans have `status:` field with appropriate value
- [ ] Completed items should be archived

---

## Phase 2: Maintenance Rules

### Folder-to-Type Mapping (CRITICAL)

Files MUST have types matching their folder location:

| Folder | Required Type |
|--------|---------------|
| `plans/**` | `type: plan` |
| `troubleshooting/**` | `type: troubleshooting` |
| `decisions/**` | `type: decision` |
| `learnings/**` | `type: learning` |
| `research/**` | `type: research` |
| `archive/**` | Original type (plan, troubleshooting, etc.) |
| All others | `type: note` |

**Fix any file where type doesn't match folder.**

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
archived_date: 2026-01-21
original_date: 2025-06-15  # When originally created
```

### Frontmatter Standards

**Required fields** - every note MUST have:

| Field | Values | Description |
|-------|--------|-------------|
| `title` | String | Human-readable title |
| `type` | `note`, `plan`, `decision`, `troubleshooting`, `research`, `learning` | Must match folder |
| `permalink` | `folder/slug-based-on-title` | Stable identifier (lowercase, hyphens) |
| `tags` | YAML array | Categorization (min 1 tag) |

**Optional fields**:

| Field | Values | When to use |
|-------|--------|-------------|
| `status` | `active`, `in-progress`, `completed`, `paused`, `deprecated` | Plans/projects with lifecycle |
| `archived_date` | `YYYY-MM-DD` | When moved to archive/ |
| `original_date` | `YYYY-MM-DD` | Original creation date (archived items) |

### Anti-Patterns to Fix

| Issue | Fix |
|-------|-----|
| `type: note` in plans/ folder | Change to `type: plan` |
| `type: note` in troubleshooting/ folder | Change to `type: troubleshooting` |
| `type: note` in decisions/ folder | Change to `type: decision` |
| `type: note` in learnings/ folder | Change to `type: learning` |
| `type: note` in research/ folder | Change to `type: research` |
| Status in tags (`- complete`, `- in-progress`) | Remove from tags, add `status:` field |
| Type in tags (`- plan`, `- implementation-plan`) | Remove, use `type:` field instead |
| Missing `status:` on plans | Add appropriate status based on content |
| Broken `memory://` links | Fix path or remove if target doesn't exist |

---

## Phase 3: Execute Changes

### Comprehensive Mode (no flags)
- **Full review of ENTIRE knowledge base** - every entity must be examined
- Can make major restructuring changes
- Can ask user for confirmation on significant changes
- **Must report total entities examined = Entities count from injected stats**

### CI Mode (--ci)
- **Diff-targeted only** - examine ONLY files from "Recent git changes"
- **NEVER ask for confirmation** - proceed autonomously
- **Conservative changes only**:
  - Fix broken links
  - Fix metadata issues (wrong type, missing required fields)
  - Archive ONLY items explicitly marked "completed" or "done"
- Skip anything requiring human judgment

---

## Output Summary (REQUIRED)

After completing maintenance, provide this summary:

```markdown
## Claude Dream Summary

**Mode:** [Comprehensive|CI]
**Date:** YYYY-MM-DD

### Statistics
| Metric | Count |
|--------|-------|
| Total entities in KB | [MUST MATCH INJECTED COUNT] |
| Entities examined | [MUST EQUAL TOTAL IN COMPREHENSIVE MODE] |
| Files modified | X |
| Files archived | X |
| Type mismatches fixed | X |
| Metadata issues fixed | X |
| Unresolved relations fixed | X |

### Changes Made

#### Type Corrections
| File | Change |
|------|--------|
| `troubleshooting/X.md` | `type: note` → `type: troubleshooting` |
| `decisions/Y.md` | `type: note` → `type: decision` |

#### Archived (moved to archive/)
| File | Reason |
|------|--------|
| `plans/X.md` | Status: completed |

#### Metadata Fixed
| File | Change |
|------|--------|
| `plans/Y.md` | Removed `- in-progress` from tags, added `status: in-progress` |

#### Broken Links Fixed
| File | Change |
|------|--------|
| `infrastructure/Y.md` | Fixed 3 broken memory:// links |

### Entities Examined But Not Modified
- X entities with valid metadata and correct types
```

**CRITICAL**: In comprehensive mode, "Entities examined" MUST equal the "Entities" count shown in the injected stats. If they don't match, you haven't completed the task.

---

## Safety Rules

1. **Never delete files** - always archive instead
2. **Preserve history** - keep breadcrumbs when consolidating
3. **Conservative by default** - when unsure, skip or ask (except in CI mode)
4. **Respect active work** - don't archive anything without clear "completed" status
5. **Maintain links** - update `memory://` references when moving files
6. **Path validation** - all operations must target `.basic-memory/` directory

---

**Begin by checking your mode from `$ARGUMENTS`, then systematically process each entity.**
