#!/bin/bash
# Syntax-check the Ansible PLAYBOOKS modified on this branch, mirroring CI's
# `ansible-playbook --syntax-check`.
#
# Why this exists alongside ansible-lint (which already syntax-checks): it is a
# lighter-weight backstop. When ansible-lint's richer environment is degraded
# and that gate warn-skips, `--syntax-check` often still runs and catches gross
# parse errors (conflicting actions, malformed YAML, bad includes). It also
# catches breakage a repo's lax .ansible-lint profile might have disabled.
#
# Like the lint gate it is DIFF-SCOPED and WARN-SKIPS on environment gaps
# (undecryptable vault, missing collection/role, broken ansible env) rather than
# false-blocking — only genuine syntax errors block (exit 2).
set -euo pipefail

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/quality-emit.sh" 2>/dev/null \
  || . "$(dirname "$0")/quality-emit.sh"
# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/ansible-lib.sh" 2>/dev/null \
  || . "$(dirname "$0")/ansible-lib.sh"

INPUT=$(cat)

if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

if ! command -v ansible-playbook &>/dev/null; then
  echo "WARNING: ansible-playbook not found in PATH — skipping Ansible syntax check" >&2
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0

ansible_quality_is_ansible_repo "$ROOT" || exit 0

YAML_FILES=$(ansible_quality_changed_yaml)
[ -z "$YAML_FILES" ] && exit 0

# Of the changed YAML, keep only files that look like PLAYBOOKS — a top-level
# YAML *sequence* (first meaningful line begins with `-`) that either targets
# hosts or imports another playbook. This excludes role task/handler files
# (also sequences, but no `hosts:`), and vars/inventory files (mappings).
PLAYBOOKS=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  first=$(grep -vE '^[[:space:]]*(#|---|$)' "$f" 2>/dev/null | head -1 || true)
  case "$first" in
    -\ *|-) ;;            # top-level sequence — candidate
    *) continue ;;        # mapping — not a playbook
  esac
  if grep -qE '^[[:space:]]*(hosts[[:space:]]*:|- import_playbook[[:space:]]*:|import_playbook[[:space:]]*:)' "$f" 2>/dev/null; then
    PLAYBOOKS+=("$f")
  fi
done <<< "$YAML_FILES"
[ ${#PLAYBOOKS[@]} -eq 0 ] && exit 0

# Keep ansible non-interactive: a vaulted reference must NOT pop a password
# prompt and hang the hook. Redirecting stdin from /dev/null turns any prompt
# into an immediate EOF error, which we then recognize as an environment gap.
export ANSIBLE_NOCOLOR=1
export ANSIBLE_RETRY_FILES_ENABLED=0

ENV_SIGNATURES='Attempting to decrypt|Decryption failed|no vault secrets|vault password|input is not a terminal|EOF|resolve module/action|was not found|not find or access|collections? (were|was) not found|ModuleNotFoundError|Traceback \(most recent call last\)'

FAILED=0
for pb in "${PLAYBOOKS[@]}"; do
  slug=$(printf '%s' "$pb" | tr -c 'A-Za-z0-9._-' '-')
  set +e
  OUT=$(ansible-playbook --syntax-check "$pb" </dev/null 2>&1)
  RC=$?
  set -e
  [ "$RC" -eq 0 ] && continue

  if printf '%s\n' "$OUT" | grep -qE "$ENV_SIGNATURES"; then
    echo "note: syntax-check skipped for $pb — environment gap (undecryptable vault, missing collection/role, or non-interactive prompt), not a syntax error." >&2
    continue
  fi

  echo "ansible-playbook --syntax-check failed for: $pb" >&2
  printf '%s\n' "$OUT" | emit_bounded "syntax-$slug.log" "ansible-playbook --syntax-check $pb"
  FAILED=1
done

[ "$FAILED" -eq 1 ] && exit 2
exit 0
