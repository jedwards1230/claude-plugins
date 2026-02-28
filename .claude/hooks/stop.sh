#\!/bin/bash
# Hook: Stop
# Fires when Claude finishes generating a response (the assistant turn ends).
#
# Runs check-plugin-versions.sh to validate plugin version consistency
# when plugin files have changed.

set -euo pipefail

SCRIPT="$CLAUDE_PROJECT_DIR/scripts/check-plugin-versions.sh"

if [ -f "$SCRIPT" ]; then
  echo "[hook:stop] Running plugin version check..."
  bash "$SCRIPT" origin/main || true
else
  echo "[hook:stop] check-plugin-versions.sh not found — skipping"
fi

exit 0
