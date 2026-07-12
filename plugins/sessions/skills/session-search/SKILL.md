---
name: session-search
description: Use when the user asks to search, scan, review, or summarize their PAST Claude Code sessions/transcripts/chat history — e.g. "find sessions where I asked X", "what did I ask about Y", "go through my claude session history", "summarize the last N days", "which sessions used agent Z", "what commands did we run". Operates on the ~/.claude/projects JSONL transcripts. Triggers on "claude sessions", "session history", "past transcripts", "go through my sessions", "previous conversations".
---

# Session Search

Search and analyze past Claude Code session transcripts with the `sessions` CLI
instead of hand-rolling `jq`/`grep`/`python` each time. The CLI bakes in the
JSONL schema and the recurring gotchas (string-vs-array content, tool-result
noise, huge files, subagent layout).

## CLI

The plugin's `bin/` is on `PATH` while it's enabled, so call `sessions` directly:

```
sessions ls    [--days N] [--project SLUG] [--limit K] [--json]   # list sessions: date, id, project, msg count, opening prompt
sessions prompts [--days N] [--project SLUG] [--grep RE] [--session ID]  # your typed prompts per session
sessions grep  PATTERN [--role user|assistant|both|hook] [--days N] [--project SLUG]  # decoded text search, skips tool noise
sessions show  SESSION_ID [--tools] [--thinking]                  # render one session readable (ID is a prefix)
sessions tools [--days N] [--project SLUG] [--top K]              # normalized tool + bash command frequency
sessions permissions [--days N] [--project SLUG] [--session ID] [--failures] [--json]  # permission denials per session + rollup
```

All commands except `show` accept `--days N` (filter by file mtime) and
`--project SLUG` (substring of the project dir, e.g. `orchestration`,
`my-project`); `show` takes a session-id prefix plus the archive flags below.

By default they also search `~/claude-archives` when that directory exists (where the companion
session-archiver plugin mirrors transcripts past the 30-day cleanup), so
aged-out sessions stay searchable; the live copy wins when a session is in
both. Override with `--archive-dir PATH` / `$SESSIONS_ARCHIVE_DIR`, or
`--no-archive` to search only the live `~/.claude` dir.

## Picking a command

| The user wants… | Use |
|---|---|
| sessions where they asked/discussed something | `grep "PATTERN" --role user` |
| everything (assistant too) mentioning a topic | `grep "PATTERN"` |
| PostToolUse hook output / harness attachments | `grep "PATTERN" --role hook` (excluded from the default search) |
| what they asked about over a period | `prompts --days N [--grep RE]` |
| an overview / "what have I been working on" | `ls --days N` |
| to read back one specific session | `show <id-prefix> [--tools]` |
| which commands/tools were run | `tools --days N` |
| what got denied / rejected, and why | `permissions --days N` |

Start narrow with `--days`/`--project` — the full corpus is ~1000 files / hundreds of MB.

### `permissions` — denial metrics

Reports permission outcomes, categorized (auto-approvals leave NO record, so
denials are the only observable signal):

- **classifier-denied** — the auto-mode classifier refused. Carries the
  classifier's own `[Category]` tag (e.g. `Modify Shared Resources`,
  `Production Deploy`, `Self-Approval`) + reason + the blocked command. This is
  the true auto-mode-classifier outcome.
- **user-rejected** — a *human* declined a permission prompt (`"The user
  doesn't want to proceed…"`). Distinct from the classifier: it's a prompt the
  classifier escalated, then the person said no. `AskUserQuestion` dismissals
  are excluded by default (closing a question popup isn't a denial); pass
  `--include-asks` to keep them.
- **tool-guard** — internal `<tool_use_error>` guard (Write-before-Read, stale
  read), not a permission event.
- **exec-failure** — the tool *ran* and errored (`Exit code 1`, timeouts). Not
  a block; hidden unless `--failures`.

Prints per-session buckets then a rollup (top reason categories + top blocked
tools). Caveat: a classifier-escalated-but-human-*approved* call is silent and
indistinguishable from a silent auto-approve, so "not denied" ≠ "classifier
auto-approved" — only denials are countable, not the approval denominator.

## Workflow

1. **Locate first, read second.** Use `grep`/`prompts`/`ls` to find the
   relevant session IDs before `show`-ing any session in full.
2. **Restate findings** as a table (date, short id, the actual ask) — the user
   can't see the raw transcript output.
3. For "find every use of X" asks, expect false positives from incidental word
   matches; confirm by reading the snippet, and note genuine vs incidental.

## Notes

- `grep` searches decoded message text only, so `tool_result` blocks and tool
  call JSON don't drown out real conversation. Its fast path pre-filters on the
  raw JSON, which is only escape-safe for ASCII patterns without quotes or
  backslashes; non-ASCII or quoted patterns fall back to decoded-text search
  automatically (correct, just slightly slower).
- `prompts`/`ls` show only genuinely *typed* prompts — `isMeta` turns,
  `<command-*>`/`<*-hook>`/`<task-notification>`/`<system-reminder>` wrappers,
  and tool results are filtered out.
- Subagent transcripts live under `<slug>/<session-uuid>/subagents/` and are
  excluded by default (the top-level session is what you usually want).
- Transcripts auto-delete after `cleanupPeriodDays` (default 30d). If the user
  wants long-term retention, that's an archival job (out of scope for this
  read-only skill).
