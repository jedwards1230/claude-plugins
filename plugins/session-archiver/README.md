# session-archiver

Archive Claude Code session transcripts — the `~/.claude/projects/<slug>/*.jsonl`
files plus their `tool-results/` and `subagents/` sidecars — to a local mirror
and (optionally) remote targets, on every session boundary. Beats the ~30-day
`cleanupPeriodDays` auto-delete and gives you a durable, complete record (full
text, tool I/O, images, subagents).

Nothing is hardcoded. All machine-specific config lives in a per-host file you
create; the plugin ships generic and safe for the public marketplace.

## What it captures

The JSONL transcript is the most complete record that exists: user + assistant
text, every tool call with full input, full tool output, inline base64 images,
and subagent sidechains. (Extended-thinking content is stored only as an
encrypted signature by Claude Code — that is not recoverable from any archive.)

## Install

```
/plugin install session-archiver@jedwards1230-plugins
```

Then create a config (see below). Until `enabled: true`, the plugin does nothing.

**Dependencies:** `jq` and `rsync` (required). `aws` CLI for S3 targets. Remote
upload tools (`rclone`, etc.) only if you use a `command` target. No dependency
on `flock` / `timeout` / `rclone` — works on stock macOS.

## Configure

Copy [`config.example.json`](./config.example.json) to one of (first found wins):

1. `$SESSION_ARCHIVER_CONFIG` (explicit path)
2. `${CLAUDE_CONFIG_DIR:-~/.claude}/session-archiver/config.json`  ← recommended
3. `<data-dir>/config.json` (see [Data directory](#data-directory) below)

This file is **per-machine and should not be committed**. Minimal config:

```json
{ "enabled": true, "local_mirror": "~/claude-archives", "sync_mode": "local-only" }
```

### Data directory

Spool markers, sync state, locks, and the log live in a data directory that
**both** the in-Claude-Code hook and the standalone drainer must resolve
identically — otherwise the drainer can't find what the hook spooled. It is, in
order of precedence:

1. `$SESSION_ARCHIVER_DATA` (explicit override — set it in **both** the hook env
   *and* the drain timer/agent if you use it)
2. `${CLAUDE_CONFIG_DIR:-~/.claude}/session-archiver`  ← canonical default

> **Upgrading from ≤ 0.2.1:** older versions anchored this dir to the plugin's
> `CLAUDE_PLUGIN_DATA` location, which only the hook could see — so in `spool`
> mode the standalone drainer looked elsewhere and never drained. As of 0.2.2
> the hook automatically migrates any leftover spool markers / state / log from
> that legacy location into the canonical dir on its next run. No manual step is
> needed; if you'd rather move it yourself, copy the `spool/`, `state/`, and
> `archive.log` from `~/.claude/plugins/.../data/session-archiver*/` into
> `~/.claude/session-archiver/`.

### Sync modes

| Mode | Behavior |
|------|----------|
| `local-only` *(default)* | Mirror locally only. Most private. |
| `inline` | Mirror, then push to remotes in a **detached background** process. No timer to install; the local mirror is the safety net if an upload drops. |
| `spool` | Mirror + drop a marker; a timer runs `drain.sh` to push with **retries**. Most robust for flaky networks / offline NAS. Install a timer (see `templates/`). |
| `blocking` | Mirror, then push **synchronously** in the hook (every event). For ephemeral CI runners where a detached/spooled upload would be killed at job end. |

> For the most robust setup, drive replication from an OS timer instead of the
> event hooks — see [Periodic sync mode (recommended)](#periodic-sync-mode-recommended).
> It pairs any non-`blocking` `sync_mode` with `"hook_events": ["PreCompact"]`.

#### Installing the spool drain timer

`spool` mode needs a timer to run `drain.sh` periodically. Templates are in
[`templates/`](./templates): `launchd-drain.plist` (macOS) and
`session-archiver-drain.{service,timer}` (systemd user units on Linux). Edit the
path to your installed `drain.sh`, then load the agent/timer.

> **macOS gotcha:** launchd starts agents with a minimal `PATH`
> (`/usr/bin:/bin:/usr/sbin:/sbin`) that excludes Homebrew, so `drain.sh` can't
> find `jq` and aborts (exit 0, nothing drained). The shipped plist sets an
> `EnvironmentVariables` `PATH` that prepends `/opt/homebrew/bin` (Apple Silicon)
> and `/usr/local/bin` (Intel) — adjust it if your `jq` lives elsewhere.

### Remote targets

Set `sync_mode` to `inline`, `spool`, or `blocking`, then enable targets. Placeholders
`{host}` `{project}` `{session}` are substituted (`{src}` `{dest_key}` also for
`command`). **Secrets are never in this file** — reference an AWS profile, an
ssh key path, or an external command.

- **`s3`** — `aws s3 sync` to any S3-compatible endpoint (`bucket`,
  `endpoint_url`, `region`, `aws_profile`, `path_style`, `prefix`). Credentials
  come from the named AWS profile (`~/.aws/credentials`). For path-style hosts
  (MinIO/Garage) set `"path_style": true`, or `aws configure set
  s3.addressing_style path --profile <name>`.
- **`rsync`** — `rsync -a` to `user@host:/path` over SSH (`BatchMode`, creates
  parent dirs) or a local/NFS `dest`. `ssh_key` optional.
- **`command`** — any command template, e.g.
  `rclone copy {src} myremote:cc/{host}/{session}`. The escape hatch for
  restic/b2/gsutil/etc. `{src}` is shell-quoted for you; quote the rest of your
  template yourself if your paths may contain spaces. The same fields are also
  exported as `$SA_SRC`, `$SA_HOST`, `$SA_PROJECT`, `$SA_SESSION`, `$SA_DEST_KEY`.

### Per-machine, multi-instance

The plugin is identical on every host; only each host's gitignored
`config.json` differs (this Mac → S3; a Linux box → NAS rsync; a laptop →
`local-only`). `{host}` in the key keeps one bucket collision-free across all
your Claude instances.

## Periodic sync mode (recommended)

Archiving transcripts is fundamentally a **file-replication** problem, not an
event problem — so the most robust deployment isn't the event hooks at all, it's
a periodic incremental sync on an OS timer.

**Why it works without ever losing a session:**

- The source `~/.claude/projects/<slug>/<uuid>.jsonl` files persist ~30 days
  (`cleanupPeriodDays`, and Claude Code only deletes them at startup), so even a
  **daily** incremental sync never loses a session to cleanup.
- The transcript is **append-only across compaction** (empirically verified on
  current Claude Code: a 10,238-line session compacted 4× kept all 696
  pre-compaction messages — compaction writes a `compact_boundary` /
  `isCompactSummary` entry but never truncates prior messages). So a plain
  periodic file copy already captures full pre-compaction detail.
- A periodic `backfill.sh --remote` therefore scans the **source of truth**,
  making it **gap-free**: it catches idle, crashed, and abnormally-exited
  sessions that the event hooks can miss. `SessionEnd` isn't even guaranteed on
  crash / `SIGKILL`.
- It has **zero per-turn latency** and never re-mirrors a growing transcript on
  every turn — and needs no spool/marker machinery.

The event hooks only add *immediacy*, which is worthless for an archive whose
source persists 30 days. **The one hook worth keeping is `PreCompact`**, purely
as a hedge: the append-only behavior is observed, not *documented* (Claude
Code's docs say the transcript format "is internal and changes between
versions"), so `PreCompact` fires right before compaction and guarantees a
pre-compaction capture *in case* some future version ever truncates the file.
It's cheap (compaction is infrequent) with zero downside.

### Configure it

1. In `config.json`, restrict the hook to the `PreCompact` hedge:

   ```json
   {
     "enabled": true,
     "local_mirror": "~/claude-archives",
     "sync_mode": "spool",
     "hook_events": ["PreCompact"]
   }
   ```

   `hook_events` is an **allowlist** of event names the in-Claude-Code hook acts
   on. Absent/empty = act on **all** events (the prior, default behavior — fully
   backward-compatible). With `["PreCompact"]`, the hook exits immediately
   (no-op, non-blocking) for `Stop`, `StopFailure`, and `SessionEnd`. No
   `hooks.json` edit is needed.

2. Install the **periodic-backfill** timer (instead of, or alongside, the spool
   drain timer) so `backfill.sh --remote` runs on an interval. Templates are in
   [`templates/`](./templates): `launchd-backfill.plist` (macOS, every 180s) and
   `session-archiver-backfill.{service,timer}` (systemd user units, every 3min).
   Edit the path to your installed `backfill.sh`, then load the agent/timer. The
   same launchd Homebrew-`PATH` fix as the drain agent applies (launchd's default
   `PATH` lacks `/opt/homebrew/bin`, so `jq` wouldn't be found).

`backfill.sh` takes a lock, so an interval shorter than a slow run is safe — a
second run that overlaps a still-running one exits cleanly rather than racing it.

### Periodic-sync vs event-hook tradeoffs

| | Periodic sync *(recommended)* | Event hooks |
|---|---|---|
| Coverage | Gap-free — scans the source of truth; catches idle/crashed/SIGKILLed sessions | Misses sessions where no event fires (`SessionEnd` not guaranteed on crash) |
| Per-turn cost | None | Re-mirrors on every `Stop`/`PreCompact` |
| Off-box recency | The timer interval (minutes) | Near-immediate |
| Machinery | One OS timer | Hooks (+ a drain timer for `spool`) |
| Pre-compaction detail | Captured (transcript is append-only) + `PreCompact` hedge | Captured by `PreCompact` |

The one honest tradeoff: **off-box recency equals the timer interval** (minutes),
and there's a small window of un-synced recent turns **only if the local disk
itself dies between ticks**. Since the local mirror is the durable record and the
source persists 30 days, that window is negligible for an archive. Keep
`PreCompact` enabled as the hedge because the append-only guarantee is observed,
not documented.

## How it works

`SessionEnd`, `Stop`, `StopFailure`, and `PreCompact` all trigger
`hooks/archive.sh`. It locks the session, skips if unchanged (mtime+size),
mirrors locally (fast, always), then hands any upload to background (`inline`)
or a spool marker (`spool`) — so it never blocks session exit and always exits 0
(the `blocking` mode instead waits for the upload; see GitHub Actions below). Re-runs are idempotent (stable
destination key + `aws s3 sync`/`rsync -a` deltas + per-session `mkdir` lock),
so all four events firing collapse to at most one real archive per change.
`PreCompact` captures the full transcript before compaction summarizes it away.

The `hook_events` config option narrows which of those four events the hook acts
on (absent = all of them). Setting `["PreCompact"]` makes the hook a no-op for
every other event — the basis of the [periodic sync mode](#periodic-sync-mode-recommended)
above, where an OS timer does the real replication.

## Backfilling existing sessions

The hooks only capture sessions that **end or compact after** the plugin is
enabled. Sessions that already existed at install time are never archived, and
will be lost when Claude Code's ~30-day cleanup deletes them. Run the backfill
script once after enabling to mirror that backlog.

Run it from the plugin's `scripts/` directory (or give the full path to the
installed copy under `~/.claude/plugins/`):

```
bash backfill.sh --dry-run     # preview what would be mirrored; copies nothing
bash backfill.sh               # mirror the backlog (local mirror only)
```

It reads the same config as the hooks, honors `exclude_project_globs` and the
`include_*` flags, and is **safe to re-run** — unchanged sessions are skipped via
the same `mtime:size` signature the hooks use. Options:

- `--dry-run` — list what would be mirrored, copy nothing
- `--project SUBSTR` — only sessions whose project slug contains `SUBSTR`
- `--projects-dir DIR` — scan `DIR` instead of `~/.claude/projects`
- `--remote` — also push each mirrored session to enabled remote targets (when
  `sync_mode` is not `local-only`)

## Retention

By default the local mirror is **kept forever** (it's an archive, and it's what
survives Claude Code's own ~30-day cleanup). To bound disk usage, set either knob
(opt-in, `0` = off, checked at most hourly):

- `retain_days` — delete mirrored sessions older than N days.
- `max_size_gb` — when the mirror exceeds this, delete oldest sessions until under.

Pruning only ever touches the local mirror, never the remote copies.

## GitHub Actions / ephemeral runners

A CI runner is destroyed at job end, so `inline` (detached) and `spool` (timer)
can lose the upload. Use `sync_mode: blocking` — it pushes synchronously in the
hook on every event, so nothing depends on the runner surviving:

```yaml
env:
  SESSION_ARCHIVER_ENABLED: "true"
  SESSION_ARCHIVER_HOST: "gh-${{ github.repository_owner }}"   # stable key prefix
  SESSION_ARCHIVER_CONFIG: ${{ github.workspace }}/.sa.json
  AWS_ACCESS_KEY_ID: ${{ secrets.CC_ARCHIVE_KEY }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.CC_ARCHIVE_SECRET }}
# .sa.json:
# {"enabled":true,"sync_mode":"blocking","local_mirror":"/tmp/cc",
#  "targets":[{"name":"s3","type":"s3","enabled":true,"bucket":"cc-archive",
#  "endpoint_url":"https://s3.example","region":"us-east-1","path_style":true,
#  "prefix":"{host}/{project}/{session}"}]}
```

The `s3` target inherits `AWS_*` env credentials (no profile needed). Simpler
alternative that skips the plugin entirely — a final workflow step:
`aws s3 sync ~/.claude/projects/ s3://cc-archive/gh/$GITHUB_REPOSITORY/$GITHUB_RUN_ID/`.

Blocking uploads must finish within the hook's 600s timeout; per-event uploads
are idempotent deltas, so only the first (full) upload of a large session is at
risk on a very slow link.

## Security

Transcripts contain **everything any tool read** — file contents, printed
secrets, `.env` values, base64 images. Treat the mirror and any bucket/NAS path
as sensitive: the local mirror is `chmod 700`, and remote targets should be
LAN-only / private, never public. Use `exclude_project_globs` to skip sensitive
repos. A redaction pass is your responsibility before sharing or training on the
archive.

## Not for training as-is

This makes a faithful **archive**. Converting JSONL → fine-tuning format
(messages / ShareGPT) — walking the `parentUuid` tree, merging subagent
sidechains, handling images, redacting secrets — is a separate ETL step.
