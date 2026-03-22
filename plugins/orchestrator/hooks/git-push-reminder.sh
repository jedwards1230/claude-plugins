#!/bin/bash
# Hook: PostToolUse (Bash tool)
# Reminds the agent to start a PR checker loop after git push.

set -euo pipefail

# Bail if jq is not available
if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")

# Only care about Bash tool calls
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Check if command contains git push (but not dry-run)
if echo "$COMMAND" | grep -qE 'git\s+push'; then
  # Exclude dry-run variants
  if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(-n|--dry-run)'; then
    exit 0
  fi
  if echo "$COMMAND" | grep -qE 'git\s+push\s+(-n|--dry-run)'; then
    exit 0
  fi

  echo "You just pushed to a remote. If you haven't already, consider starting a PR checker loop to monitor CI status: \`/loop 5m /pr-checker\`"
fi

exit 0
