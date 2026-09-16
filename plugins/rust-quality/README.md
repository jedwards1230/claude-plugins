# rust-quality

Rust quality gates — auto-format on edit (`rustfmt`), and on Stop/SubagentStop/
TaskCompleted/TeammateIdle run `cargo clippy --all-targets -- -D warnings`,
`cargo test --all-targets`, and `cargo audit` (when installed) against crates
owning the files modified on the current branch. A failure blocks (exit 2).

## A missing system library is skipped, not failed

A crate whose dependency graph resolves a `-sys` crate needs the matching system
development package (`libdbus-1-dev`, `libssl-dev`, …). Where it is absent the
build fails in a build script, in `pkg-config`, or in the linker — **before a
single line of the project's own code is compiled**. That is an environment gap,
not a defect in the diff, and blocking on it reports a problem the author cannot
fix by editing code.

`cargo test` and `cargo clippy` therefore recognise that class of failure, print
one WARNING naming the missing library, and **do not block** (exit 0). Everything
else still blocks as before. `cargo audit` is unaffected — it reads `Cargo.lock`
and needs no build, so it still runs for the crate.

The detection is deliberately narrow (`hooks/rust-system-deps.sh`): it matches
only messages a build script, `pkg-config`, the C compiler, or the linker emits
while *looking for a system library*. None of them can be produced by a type
error, a failing assertion, or a clippy lint, so a real failure is never
swallowed. `failed to run custom build command` is excluded on purpose — a build
script can fail for reasons that are genuinely the author's.

## Bounded check output

On a check failure, the full tool output is written to a log file and only the
first **N lines** are emitted to the Stop feedback, followed by a footer
pointing at the log and a reproduce command. This keeps the Stop feedback from
being flooded with hundreds of lines of `cargo` output every turn.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env var
  (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host exposes
  one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` — the sanctioned persistent
  per-plugin dir (`~/.claude/plugins/data/{id}/`). Falls back to
  `${TMPDIR:-/tmp}` on older hosts. Logs are named per crate
  (`<tool>-<crate-slug>.log`, where the slug is the crate dir with every
  non-`[A-Za-z0-9._-]` char replaced by `-`) so multiple failing crates don't
  overwrite each other: `clippy-<slug>.log`, `audit-<slug>.log`,
  `test-<slug>.log`.

The blocking behavior (exit codes, per-crate dispatch, graceful tool-absence)
is unchanged — only the volume of emitted output is bounded.
