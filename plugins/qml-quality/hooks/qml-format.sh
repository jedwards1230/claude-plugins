#!/bin/bash
# Auto-format QML files after Write or Edit.
#
# Mirrors go-quality/hooks/go-fmt.sh: format in place, never block. A parser
# error (e.g. the qmlformat 6.11 regression that fails on some valid files)
# just leaves the file untouched — `|| true` keeps the hook a no-op in that case.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v qmlformat &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
  if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.qml$ ]]; then
    qmlformat -i "$FILE_PATH" 2>/dev/null || true
  fi
fi

exit 0
