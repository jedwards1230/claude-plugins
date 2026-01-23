# Note Templates

## Frontmatter

All notes use the same basic frontmatter:

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

**Note:** The `type` field is always `note`. The folder location (learnings/, decisions/, etc.) provides categorization.

## Observation Markers

Use semantic markers for knowledge-graph linking:

```markdown
- [fact] Objective information
- [gotcha] Surprises, edge cases, warnings
- [pattern] Reusable approaches
- [solution] Fixes, workarounds
- [problem] Issues encountered
```

**Relationship markers** (for linking entities):
```markdown
- [uses] [[Other Topic]] - dependency relationship
- [implements] [[Decision]] - implementation of a choice
- [relates_to] [[Related Note]] - general connection
```

## Flexible Structure

Notes should be pragmatic, not rigid. Common patterns:

**Learnings** - narrative explaining what was discovered:
```markdown
# Title

Brief context of what this covers.

## Key Findings
- [fact] Important discovery
- [gotcha] Watch out for this

## Details
Prose explanation with code examples as needed.
```

**Decisions** - document what was chosen and why:
```markdown
# Title

## Decision
What was decided and the rationale.

## Context
Why this decision was needed.

## Impact
- [fact] What changed as a result
```

**Troubleshooting** - investigation narrative:
```markdown
# Title

## Problem
What went wrong, symptoms observed.

## Investigation
Steps taken, what was discovered.

## Root Cause
- [problem] The actual cause

## Solution
- [solution] How it was fixed
```

## Tags

Use 3-5 tags for discoverability:
- **Domain**: `kubernetes`, `ansible`, `home-automation`
- **Topic**: `storage`, `networking`, `oauth`, `mcp`
- **Status**: `planning`, `evergreen`, `needs-review`
