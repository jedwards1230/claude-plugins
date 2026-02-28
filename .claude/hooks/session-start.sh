#!/bin/bash
# Hook: SessionStart (matcher: "startup")
# Fires once when a fresh Claude Code session begins (not on resume).
#
# In Claude Code Web each session starts from a clean ephemeral container,
# so tools that are not in the image must be installed here.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[hook:session-start] Running in Claude Code Web — installing tools..."

  # Install jq if missing
  if ! command -v jq &>/dev/null; then
    apt-get update -qq && apt-get install -y --no-install-recommends jq
  fi

  # Install yq if missing
  if ! command -v yq &>/dev/null; then
    curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq
  fi

  # Install shellcheck if missing
  if ! command -v shellcheck &>/dev/null; then
    apt-get update -qq && apt-get install -y --no-install-recommends shellcheck
  fi

  echo "[hook:session-start] Tools ready."
else
  echo "[hook:session-start] Running in local devcontainer — tools pre-installed."
fi

# Always exit 0 — never block the session from starting
exit 0
