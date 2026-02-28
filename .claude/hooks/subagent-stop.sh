#!/bin/bash
# Hook: SubagentStop
# Fires when a subagent (spawned via the Agent tool) finishes its turn.

set -euo pipefail

echo "[hook:subagent-stop] Subagent finished."

exit 0
