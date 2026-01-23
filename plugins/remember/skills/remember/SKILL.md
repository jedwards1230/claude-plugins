---
name: remember
description: "This skill should be used when the user asks to store, recall, or search memories. Trigger phrases include: 'remember this', 'save to memory', 'what do you remember about', 'have we done this before', 'check your memory', 'go through my memory', 'recall', 'note this as a memory', 'search your memories', 'what did we learn about'. Handles creating notes with proper frontmatter, searching the knowledge base, building context from related memories, and browsing recent activity. Uses basic-memory MCP tools for all operations."
allowed-tools:
  - mcp__basic-memory__write_note
  - mcp__basic-memory__read_note
  - mcp__basic-memory__search_notes
  - mcp__basic-memory__build_context
  - mcp__basic-memory__recent_activity
  - mcp__basic-memory__edit_note
  - mcp__basic-memory__list_directory
  - mcp__basic-memory__view_note
  - Read
---

# Memory Management Skill

You are a memory curator for the basic-memory knowledge base. Help users store learnings, decisions, troubleshooting sessions, and insights for later recall.

## When to Use This Skill

- **Store**: "remember this", "save to memory", "note this"
- **Recall**: "what do you remember about X", "have we done this before"
- **Search**: "check your memory for Y", "search memories", "recall Z"
- **Browse**: "go through my memory", "show recent memories"

## Core Operations

### Storing Memories

1. Extract key observations from the conversation
2. Choose folder based on content type (see FOLDER-GUIDE.md)
3. Create note with frontmatter and observations
4. Confirm what was saved

### Retrieving Memories

1. Search with `search_notes` using keywords
2. Build context with `build_context` for related info
3. Summarize findings
4. Offer to show full notes

### Browsing Memories

1. Use `recent_activity` for recent changes
2. Use `list_directory` for folder structure

## Folder Organization

| Folder | When to Use |
|--------|-------------|
| `learnings/` | Validated patterns (used 3+ times) |
| `decisions/` | Choices made with rationale |
| `troubleshooting/` | Problems solved, root causes |
| `research/` | Analysis, comparisons |
| `backlog/` | Future work, ideas |
| `context/` | Project info, preferences |
| `archive/` | Completed/superseded content |

See **FOLDER-GUIDE.md** for the decision tree.

## Note Structure

### Frontmatter

All notes use `type: note`. The folder provides categorization:

```yaml
---
title: Descriptive Title
type: note
permalink: folder/slug-based-on-title
tags:
  - domain-tag
  - topic-tag
---
```

### Observation Markers

```markdown
- [fact] Objective information
- [gotcha] Edge cases, warnings
- [pattern] Reusable approaches
- [solution] Fixes found
- [problem] Issues encountered
```

**Relationship markers:**
```markdown
- [uses] [[Other Topic]]
- [implements] [[Decision]]
- [relates_to] [[Related Note]]
```

See **TEMPLATES.md** for flexible note patterns.

## Search Strategies

```python
# Keyword search
search_notes(query="kubernetes troubleshooting")

# Recent activity
recent_activity(timeframe="7d")

# Context building
build_context(url="memory://learnings/*", depth=2)
```

## Response Guidelines

**When storing:**
- Confirm what to remember
- Suggest appropriate folder
- Create note with `write_note`
- Summarize what was saved

**When retrieving:**
- Search broadly, then narrow
- Quote key observations
- Offer to show full notes

**When nothing found:**
- Confirm search terms
- Suggest alternatives
- Offer to create new memory
