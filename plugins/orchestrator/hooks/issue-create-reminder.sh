#!/bin/bash
# Hook: PostToolUse (Bash tool)
# Reminds the agent to track newly created issues as tasks in the agent loop.

set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

if echo "$COMMAND" | grep -qE 'gh\s+issue\s+create'; then
  echo "New issue created. If you're running an agent loop, add this issue to your task list with TaskCreate and set up any blockedBy dependencies."
fi

exit 0
