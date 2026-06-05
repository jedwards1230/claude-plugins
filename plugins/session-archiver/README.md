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
3. `<plugin-data-dir>/config.json`

This file is **per-machine and should not be committed**. Minimal config:

```json
{ "enabled": true, "local_mirror": "~/claude-archives", "sync_mode": "local-only" }
```

### Sync modes

| Mode | Behavior |
|------|----------|
| `local-only` *(default)* | Mirror locally only. Most private. |
| `inline` | Mirror, then push to remotes in a **detached background** process. No timer to install; the local mirror is the safety net if an upload drops. |
| `spool` | Mirror + drop a marker; a timer runs `drain.sh` to push with **retries**. Most robust for flaky networks / offline NAS. Install a timer (see `templates/`). |
| `blocking` | Mirror, then push **synchronously** in the hook (every event). For ephemeral CI runners where a detached/spooled upload would be killed at job end. |

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

## How it works

`SessionEnd`, `Stop`, `StopFailure`, and `PreCompact` all trigger
`hooks/archive.sh`. It locks the session, skips if unchanged (mtime+size),
mirrors locally (fast, always), then hands any upload to background (`inline`)
or a spool marker (`spool`) — so it never blocks session exit and always exits 0
(the `blocking` mode instead waits for the upload; see GitHub Actions below). Re-runs are idempotent (stable
destination key + `aws s3 sync`/`rsync -a` deltas + per-session `mkdir` lock),
so all four events firing collapse to at most one real archive per change.
`PreCompact` captures the full transcript before compaction summarizes it away.

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
