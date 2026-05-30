#!/bin/bash
# Auto-format Rust files after Write or Edit.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
  if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.rs$ ]]; then
    # rustfmt formats a single file in place, matching gofmt's per-file model.
    # Prefer `cargo fmt`'s edition-aware rustfmt via `rustfmt` if available.
    if command -v rustfmt &>/dev/null; then
      rustfmt "$FILE_PATH" 2>/dev/null || true
    fi
  fi
fi

exit 0
