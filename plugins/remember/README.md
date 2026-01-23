# Remember Plugin

Memory management skill for storing and retrieving knowledge via basic-memory.

## Overview

This skill enables Claude to:
- **Store memories**: Save learnings, decisions, troubleshooting sessions, and insights
- **Retrieve memories**: Search and recall past knowledge
- **Browse memories**: Navigate the knowledge base

## Usage

This is a **skill** (not a command), so Claude invokes it automatically based on context.

**Trigger phrases:**
- "remember this" / "save to memory" / "note this as a memory"
- "what do you remember about X" / "have we done this before"
- "check your memory for Y" / "search memories" / "recall Z"
- "go through my memory" / "show recent memories"

## Folder Organization

| Folder | Type | Purpose |
|--------|------|---------|
| `learnings/` | learning | Validated patterns (used 3+ times) |
| `decisions/` | decision | Choices with rationale |
| `troubleshooting/` | troubleshooting | Debug sessions, root causes |
| `research/` | research | Analysis, comparisons |
| `backlog/` | note | Future work, ideas |
| `context/` | note | Project context, preferences |
| `archive/` | varies | Completed/superseded content |

## Note Structure

All notes use frontmatter:

```yaml
---
title: Note Title
type: learning|decision|troubleshooting|research|note
permalink: folder/slug-based-on-title
tags:
  - tag1
  - tag2
---
```

## Observation Categories

- `[fact]` - Objective information
- `[gotcha]` - Edge cases, surprises
- `[pattern]` - Reusable approaches
- `[decision]` - Choices made
- `[learning]` - Insights gained
- `[solution]` - Fixes found
- `[problem]` - Issues encountered

## Requirements

- basic-memory MCP server configured
- Knowledge base project configured in basic-memory
