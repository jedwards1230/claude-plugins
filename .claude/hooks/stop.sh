#\!/bin/bash
# Hook: Stop
# Fires when Claude finishes generating a response (the assistant turn ends).
#
# Runs check-plugin-versions.sh to validate plugin version consistency
# when plugin files have changed.

set -euo pipefail

SCRIPT="$CLAUDE_PROJECT_DIR/scripts/check-plugin-versions.sh"

if [ -f "$SCRIPT" ]; then
  bash "$SCRIPT" origin/main || true
else
fi

exit 0
