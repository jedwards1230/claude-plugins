# sessions

Search and analyze your past Claude Code session transcripts — the
`~/.claude/projects/<slug>/*.jsonl` history — with a `sessions` CLI instead of
hand-rolling `jq`/`grep`/`python` each time. Zero dependencies (stdlib Python),
read-only, nothing leaves your machine.

The CLI bakes in the JSONL schema and the recurring gotchas (string-vs-array
content, tool-result noise, huge files, subagent layout). A `session-search`
skill points Claude at it automatically when you ask to search or summarize past
sessions. A matching `session-search` **agent** does the same job as a subagent —
spawn it mid-chat to run the search in its own context and get back a digest
instead of raw transcript output.

## Install

```
/plugin install sessions@jedwards1230-plugins
```

The plugin's `bin/` is on `PATH` while enabled, so call `sessions` directly.

## Commands

```
sessions ls      [--days N] [--project SLUG] [--limit K] [--json]   # list sessions: date, id, project, msg count, opening prompt
sessions prompts [--days N] [--project SLUG] [--grep RE] [--session ID]  # your typed prompts per session
sessions grep    PATTERN [--role user|assistant|both] [--days N] [--project SLUG]  # decoded text search, skips tool noise
sessions show    SESSION_ID [--tools] [--thinking]                  # render one session readable (ID is a prefix)
sessions tools   [--days N] [--project SLUG] [--top K]              # normalized tool + bash command frequency
```

All commands except `show` accept `--days N` (filter by file mtime) and
`--project SLUG` (substring of the project dir).

## Archive integration

If the companion [`session-archiver`](../session-archiver) plugin is mirroring
transcripts past Claude Code's ~30-day cleanup, `sessions` also searches
`~/claude-archives` when it exists, so aged-out sessions stay searchable. The
live copy wins when a session is in both. Override with `--archive-dir PATH` /
`$SESSIONS_ARCHIVE_DIR`, or `--no-archive` to search only the live `~/.claude`.

**Dependencies:** Python 3 (stdlib only).
