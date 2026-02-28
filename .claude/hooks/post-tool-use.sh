#\!/bin/bash
# Hook: PostToolUse
# Fires after every tool call. Receives the tool output as JSON on stdin.

set -euo pipefail

# Read stdin (tool output JSON is always passed here)
output=$(cat)
tool_name=$(echo "$output" | jq -r '.tool_name // empty' 2>/dev/null || true)
file_path=$(echo "$output" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)

echo "[hook:post-tool-use] tool=$tool_name file=$file_path"

exit 0
