# swift-quality

Swift quality gates for the SwiftUI-app + local-SPM-packages repo shape —
config-gated auto-format on edit, and on Stop/SubagentStop/TaskCompleted/
TeammateIdle run SwiftLint plus per-package `swift test` against the packages
owning the files modified on the current branch. A failure blocks (exit 2).
Ships a `swift` skill (idioms + shared review checklist/severity rubric) and
`swift-developer` / `swift-reviewer` agents that preload it.

## Gate design (what runs, what deliberately doesn't)

Swift has no single canonical formatter/linter, so the hooks mirror what the
repo opted into rather than imposing a style:

- **Format (PostToolUse)** — only when a config is found walking up from the
  edited file: `.swiftformat` → SwiftFormat, `.swift-format` → Apple
  swift-format. No config → no-op.
- **Lint (Stop)** — only when the repo root has `.swiftlint.yml`; lints just
  the modified files. SwiftLint's non-zero exit (error-severity violations)
  blocks.
- **Test (Stop)** — walks up from each modified `.swift` file to its owning
  `Package.swift` and runs `swift test` per package. Packages whose
  `platforms:` list has no `.macOS` entry are skipped (host `swift test`
  can't build them; CI covers them).
- **App-target code is NOT hook-gated** — building an `.xcodeproj` target
  needs xcodebuild + a simulator (minutes per run). CI owns that gate; the
  SessionStart probe reminds the assistant to run the CI-mirroring xcodebuild
  commands before handing off a PR that touches app code.

Claude Code Web (Linux) has no Swift/Xcode toolchain — the SessionStart hook
announces the gates are dormant there instead of installing anything.

## Bounded check output

On a check failure, the full tool output is written to a log file and only the
first **N lines** are emitted to the Stop feedback, followed by a footer
pointing at the log and a reproduce command.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env
  var (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host
  exposes one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` — the sanctioned persistent
  per-plugin dir (`~/.claude/plugins/data/{id}/`). Falls back to
  `${TMPDIR:-/tmp}` on older hosts. Logs are named per package
  (`test-<package-slug>.log`) plus `swiftlint.log`, so multiple failing
  packages don't overwrite each other.
