#!/bin/bash
# SessionStart hook for ansible-quality.
#
# Two responsibilities:
#   1. In Claude Code Web (CLAUDE_CODE_REMOTE=true), best-effort install
#      ansible-lint (which pulls ansible-core) and jq into the ephemeral
#      environment so the gates work out of the box. Unlike tofu/go (single
#      static binaries), ansible-lint is a pip install with a real dependency
#      tree, so this is heavier and slower and may fail offline — the gates are
#      built to warn-skip when it does. Locally, tools are expected pre-installed.
#   2. Probe regardless of remote/local and emit stdout context (read by Claude
#      as a system reminder) when the gates would be degraded by missing tools.

set +e  # Never exit on error in session-start

# ---------------------------------------------------------------------------
# Install step (remote only)
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "[ansible-quality] Running in Claude Code Web — checking tools..." >&2

  # jq is required by the hook scripts for stdin JSON parsing (loop guards).
  if ! command -v jq &>/dev/null; then
    echo "[ansible-quality] Installing jq..." >&2
    apt-get update >/dev/null 2>&1 && apt-get install -y jq >/dev/null 2>&1 || \
      echo "[ansible-quality] WARNING: jq install failed — hooks may not work" >&2
  fi

  # ansible-lint (pulls ansible-core, which provides ansible-playbook).
  if ! command -v ansible-lint &>/dev/null; then
    echo "[ansible-quality] Installing ansible-lint (pip; this also pulls ansible-core)..." >&2
    if command -v pipx &>/dev/null; then
      pipx install ansible-lint >/dev/null 2>&1
    fi
    if ! command -v ansible-lint &>/dev/null && command -v python3 &>/dev/null; then
      python3 -m pip install --user --quiet ansible-lint >/dev/null 2>&1
    fi
    # ~/.local/bin (pip --user) and pipx bins aren't always on PATH yet.
    export PATH="$HOME/.local/bin:$PATH"
    if command -v ansible-lint &>/dev/null; then
      echo "[ansible-quality] ansible-lint installed" >&2
    else
      echo "[ansible-quality] WARNING: ansible-lint install failed — lint/syntax gates will skip this session" >&2
    fi
  fi

  echo "[ansible-quality] Install step done" >&2
fi

# ---------------------------------------------------------------------------
# Probe: missing tools, with per-tool impact messaging.
# ---------------------------------------------------------------------------

# Stay dormant in non-Ansible repos. This plugin is portable and may be enabled
# globally; its hooks all self-gate on being in an Ansible project, so there's
# no point nagging about missing ansible-lint/jq in a repo with no Ansible at
# all. Reuse the same project-detection the gates use.
# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/ansible-lib.sh" 2>/dev/null \
  || . "$(dirname "$0")/../hooks/ansible-lib.sh" 2>/dev/null || true
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
IS_ANSIBLE_REPO=false
if [ -n "$REPO_ROOT" ] && command -v ansible_quality_is_ansible_repo &>/dev/null; then
  ansible_quality_is_ansible_repo "$REPO_ROOT" && IS_ANSIBLE_REPO=true
fi

MISSING_LINT=true
MISSING_PLAYBOOK=true
MISSING_JQ=true

command -v ansible-lint     &>/dev/null && MISSING_LINT=false
command -v ansible-playbook &>/dev/null && MISSING_PLAYBOOK=false
command -v jq               &>/dev/null && MISSING_JQ=false

IMPACT_LINES=()
$MISSING_LINT && IMPACT_LINES+=("  - ansible-lint missing — the primary Stop lint gate skips; no ansible-lint quality gate runs this session.")
$MISSING_PLAYBOOK && IMPACT_LINES+=("  - ansible-playbook missing — the Stop syntax-check gate skips (no playbook parse validation).")
$MISSING_JQ && IMPACT_LINES+=("  - jq missing — the gates lose their stop_hook_active loop guard.")

if $IS_ANSIBLE_REPO && [ ${#IMPACT_LINES[@]} -gt 0 ]; then
  printf '[ansible-quality] Quality gates degraded — missing tools detected:\n\n'
  for line in "${IMPACT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
  cat <<'EOF'

Install:
  ansible-lint (pulls ansible-core):  pipx install ansible-lint
                                      (or: pip install --user ansible-lint;
                                       macOS: brew install ansible-lint)
  jq:                                 brew install jq / apt-get install jq

Please alert the user about the missing tools so they can install them or move
to an environment that has them — not all chat clients surface hook output, so
a human-readable mention in your next reply is the only way they'll know.
EOF
fi

exit 0
