#!/bin/bash
# Auto-format OpenTofu files after Write or Edit.
#
# Mirrors go-quality/hooks/go-fmt.sh: format in place, never block. `tofu fmt`
# accepts a single file path and rewrites it just like `gofmt -w`. JSON config
# (.tf.json / .tofu.json) is intentionally not matched — tofu fmt only formats
# HCL native syntax and silently ignores JSON.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v tofu &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
  if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.(tf|tofu|tfvars)$ ]]; then
    tofu fmt "$FILE_PATH" >/dev/null 2>&1 || true
  fi
fi

exit 0
