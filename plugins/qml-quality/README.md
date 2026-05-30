# qml-quality

QML quality gates — auto-format on edit (`qmlformat -i`), and on Stop/
SubagentStop check that modified `.qml` files are formatted (mirrors CI). The
format check **blocks** (exit 2) when a file parses cleanly but is not
formatted; `qmllint` runs **warn-only** (non-blocking).

## Bounded / summarized qmllint output

`qmllint` is noisy off-target — without Quickshell installed it floods the Stop
feedback with `[import]` and `[unqualified]` warnings. Instead of dumping every
line, the check now:

1. Collects the full raw `qmllint` output to a log file.
2. Prints a compact one-line summary: `<actionable> actionable warning(s),
   <noise> off-target (import/unqualified, …)`.
3. Emits **only the actionable warnings** (those NOT tagged `[import]` /
   `[unqualified]`; layout-positioning warnings are kept), bounded to the first
   **N lines**.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env var
  (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host exposes
  one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` — the sanctioned persistent
  per-plugin dir (`~/.claude/plugins/data/{id}/`). Falls back to
  `${TMPDIR:-/tmp}` on older hosts. Logs: `qmllint.log` (full raw),
  `qmllint-actionable.log` (filtered subset).

The blocking format-check behavior is unchanged — only the qmllint output is
summarized + bounded.
