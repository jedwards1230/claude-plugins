#\!/bin/bash
# Hook: PreToolUse
# Fires before every tool call. Receives the tool input as JSON on stdin.
#
# Exit codes:
#   0 — allow the tool call to proceed
#   2 — block the tool call (Claude sees your stderr output as the reason)

set -euo pipefail

# Read stdin (tool input JSON is always passed here)
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)

echo "[hook:pre-tool-use] tool=$tool_name"

exit 0
