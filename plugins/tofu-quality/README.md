# tofu-quality

OpenTofu quality gates — auto-format on edit (`tofu fmt`), and on Stop/
SubagentStop/TaskCompleted/TeammateIdle:

1. **Format check** (`tofu fmt -check`) — **blocks** (exit 2) when a modified
   `.tf` / `.tofu` / `.tfvars` file is not formatted. Pure and deterministic; no
   provider/backend init required.
2. **Validate** (`tofu validate`) — **blocks** on genuine validation errors in
   directories owning the config files modified on this branch. Mirrors CI's
   `tofu init -backend=false && tofu validate`.

All gates are **diff-based**: they act only on `.tf` / `.tofu` / `.tfvars` /
`.tf.json` / `.tofu.json` files modified in the working tree, staged, or on the
current branch vs. its merge-base with `main`/`master`. `.terraform/` caches and
nested `worktrees/` are excluded, and a `stop_hook_active` guard prevents
infinite Stop loops.

## Why validate is init-gated (and warn-only when init can't run)

`tofu validate` requires an **initialized** working directory. Without
`tofu init`, it fails with *"Missing required provider"* even on perfectly valid
config — that's an environment gap, not a code defect. Blocking on it would
false-fire on every Stop. So the validate hook:

1. Runs `tofu init -backend=false -input=false` first when a directory has no
   `.terraform/`. Providers are cached via `TF_PLUGIN_CACHE_DIR` (under the
   plugin's persistent data dir), so only the first run hits the network.
2. If init **cannot** complete (offline, no provider cache, backend/creds
   needed), it prints a one-line note and **skips** validate for that directory
   — it never blocks on an environment gap.
3. **Blocks (exit 2) only** on real `tofu validate` errors once init has
   succeeded (or the directory was already initialized).

> Note: running validate auto-creates a `.terraform/` directory (and may write a
> `.terraform.lock.hcl`) in initialized config dirs — the same artifacts
> `tofu init` always produces. `.terraform/` is conventionally gitignored.

## Auto-format on edit

A `PostToolUse` hook runs `tofu fmt <file>` in place after every `Write`/`Edit`
of a `.tf` / `.tofu` / `.tfvars` file (the `gofmt -w` equivalent). It never
blocks. JSON config (`.tf.json` / `.tofu.json`) is left untouched — `tofu fmt`
only formats HCL native syntax.

## Claude Code Web

In Claude Code Web (`CLAUDE_CODE_REMOTE=true`), the `SessionStart` hook installs
the OpenTofu CLI (a single static binary, SHA256-verified) and `jq` into the
ephemeral environment so the format/validate gates work out of the box.
Provider downloads for `validate` are **not** pre-fetched — validate stays
best-effort there.

## Bounded check output

On a validate failure, the full `tofu` output is written to a log file and only
the first **N lines** are emitted to the Stop feedback, followed by a footer
pointing at the log and a reproduce command. This keeps the Stop feedback from
being flooded every turn.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env var
  (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host exposes
  one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` — the sanctioned persistent
  per-plugin dir (`~/.claude/plugins/data/{id}/`). Falls back to
  `${TMPDIR:-/tmp}` on older hosts. Validate logs are named per directory
  (`validate-<dir-slug>.log`, where the slug is the directory path with every
  non-`[A-Za-z0-9._-]` char replaced by `-`) so multiple failing directories
  don't overwrite each other.

## Requirements

- [`tofu`](https://opentofu.org/docs/intro/install/) (OpenTofu CLI) — `brew install opentofu`
- `jq` — used by the hooks to parse hook stdin (loop guard + edited-file path)

If a tool is missing the gates degrade gracefully (skip with a warning) rather
than erroring; the `SessionStart` probe reports what's degraded.
