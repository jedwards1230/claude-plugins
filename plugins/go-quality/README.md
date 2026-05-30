# go-quality

Go quality gates — auto-format on edit (`gofmt`), and on Stop/SubagentStop/
TaskCompleted/TeammateIdle run `go vet ./...`, `go test ./...`, and
`golangci-lint run` against modules owning the files modified on the current
branch. A failure blocks (exit 2).

## Bounded check output

On a check failure, the full tool output is written to a log file and only the
first **N lines** are emitted to the Stop feedback, followed by a footer
pointing at the log and a reproduce command. This keeps the Stop feedback from
being flooded with hundreds of lines of `go`/`golangci-lint` output every turn.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env var
  (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host exposes
  one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` — the sanctioned persistent
  per-plugin dir (`~/.claude/plugins/data/{id}/`). Falls back to
  `${TMPDIR:-/tmp}` on older hosts. Logs: `vet.log`, `test.log`,
  `golangci-lint.log`.

The blocking behavior (exit codes, per-module dispatch, graceful tool-absence)
is unchanged — only the volume of emitted output is bounded.
