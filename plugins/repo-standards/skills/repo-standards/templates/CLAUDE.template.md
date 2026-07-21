<!--
This is the canonical agent file's shape (see references/repo-docs.md).

- Shape 1 — no AGENTS.md: copy this verbatim to CLAUDE.md. Done.
- Shape 2 — the repo has an AGENTS.md: AGENTS.md is canonical, so copy this BODY there
  instead, retitled `# AGENTS.md`, with the @CONTRIBUTING.md import replaced by a plain
  link ("Build, test, and lint commands live in [CONTRIBUTING.md](CONTRIBUTING.md).") —
  @imports only work in CLAUDE.md. CLAUDE.md then becomes just:

      # CLAUDE.md

      @AGENTS.md
      @CONTRIBUTING.md

  Never point AGENTS.md back at CLAUDE.md; the wrapper direction is one-way.

Delete this comment block before committing.
-->

# CLAUDE.md

@CONTRIBUTING.md

Guidance for coding agents working in this repository.

## What this is

**<repo-name>** — <one-paragraph purpose: what it is, what it is not, and its one
most important relationship to a sibling repo or system, if any>.

Full requirements: [`docs/PRD.md`](docs/PRD.md) <!-- or docs/CONTRACT.md — pick one; see
references/knowledge-base.md -->. Read it before structural changes.
[`docs/TESTING.md`](docs/TESTING.md) holds the test strategy.
<!-- One routing line per additional docs/ file. Every file under docs/ must be reachable
     from this map. At most ONE extra @import above (beyond CONTRIBUTING) — and only for a
     doc that pays for its tokens on nearly every task. -->

## Architecture invariants (violations are bugs)

1. **<invariant name>**: <a property a reviewer can check against a diff — layering,
   security, data-safety, or compatibility. Breaking it is a bug even if tests pass.>
2. …
<!-- ≤ 7 entries. Style/conventions go in Design discipline below, not here. -->

<!-- Infra repos only — delete otherwise:
## Authority boundary

| Operation | Performed by | Mechanism | Why / escalation |
|---|---|---|---|
| plan / diff | agent, freely | <read-only creds / CI plan job> | safe read |
| apply | <CI only, human-approved / merge-to-main via reconciler> | <workflow + environment gate / sync policy> | <why> |
| <human-only op> | human only | <no creds in CI or agent context> | <why> |
-->

## Design discipline

- **<convention>**: <the judgment call this repo makes consistently — config-over-hardcode,
  visible-artifacts-over-hidden-state, etc.>

## Commands

```bash
<run/serve/demo commands unique to this codebase — build/test/lint live in CONTRIBUTING.md
and arrive via the @import; do not restate them here>
```

## Layout

- `<dir>/` — <one line: what it is> — see its package doc.
<!-- One line per component. Depth lives in the component's doc.go / README (the spoke),
     updated in the same PR as the component. -->
