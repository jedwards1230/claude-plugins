#!/bin/bash
# Auto-format Swift files after Write or Edit — config-gated.
#
# Swift has no single canonical formatter the way Go/Rust do, and the two
# common ones (nicklockwood SwiftFormat vs Apple swift-format) disagree on
# style. Formatting a repo that hasn't opted into one would fight its existing
# style, so this hook only formats when the repo declares a formatter config:
#
#   .swiftformat   found walking up from the file → `swiftformat` (SwiftFormat)
#   .swift-format  found walking up from the file → `swift format` (Apple,
#                  bundled with Xcode 16+ toolchains)
#
# No config anywhere up the tree → no-op. Missing tool for the config that IS
# present → no-op here; the SessionStart probe already surfaced it.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
  if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.swift$ && -f "$FILE_PATH" ]]; then
    # Walk up from the file looking for a formatter config. First hit wins,
    # so a nested SPM package's config shadows a repo-root one.
    d=$(dirname "$FILE_PATH")
    while :; do
      if [[ -f "$d/.swiftformat" ]]; then
        # SwiftFormat discovers .swiftformat itself when given a path, so no
        # explicit --config needed — the walk-up only decides IF we format.
        if command -v swiftformat &>/dev/null; then
          swiftformat "$FILE_PATH" 2>/dev/null || true
        fi
        break
      fi
      if [[ -f "$d/.swift-format" ]]; then
        # Apple swift-format ships inside Xcode 16+ toolchains as a `swift`
        # subcommand; a standalone `swift-format` install also works.
        if command -v swift-format &>/dev/null; then
          swift-format format -i --configuration "$d/.swift-format" "$FILE_PATH" 2>/dev/null || true
        elif command -v swift &>/dev/null; then
          swift format format -i --configuration "$d/.swift-format" "$FILE_PATH" 2>/dev/null || true
        fi
        break
      fi
      parent=$(dirname "$d")
      [[ "$parent" == "$d" ]] && break # reached filesystem root — no config, no-op
      d="$parent"
    done
  fi
fi

exit 0
