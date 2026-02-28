#!/bin/bash
# Hook: SessionStart (matcher: "startup")
# Fires once when a fresh Claude Code session begins (not on resume).
#
# In Claude Code Web each session starts from a clean ephemeral container,
# so tools that are not in the image must be installed here.

set +e  # Never exit on error in session-start

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[session-start] Running in Claude Code Web — installing tools..." >&2

  # Install jq if missing
  if ! command -v jq &>/dev/null; then
    apt-get update -qq && apt-get install -y --no-install-recommends jq
  fi

  # Install yq if missing
  if ! command -v yq &>/dev/null; then
    curl -fsSL https://github.com/mikefarah/yq/releases/download/v4.52.4/yq_linux_amd64 \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq
  fi

  # Install shellcheck if missing
  if ! command -v shellcheck &>/dev/null; then
    apt-get update -qq && apt-get install -y --no-install-recommends shellcheck
  fi

  echo "[session-start] Tools ready." >&2
else
  echo "[session-start] Running in local devcontainer — tools pre-installed." >&2
fi

# Always exit 0 — never block the session from starting
exit 0
