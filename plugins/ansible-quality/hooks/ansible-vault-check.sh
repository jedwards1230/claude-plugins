#!/bin/bash
# Flag vault-named YAML files modified on this branch that are NOT encrypted —
# a cheap guard against committing a plaintext secrets file by accident.
#
# WARN-ONLY by design: it never blocks (always exits 0). Vault file-naming
# conventions vary and a repo may legitimately keep an example/template
# `vault.yml` in plaintext, so a hard block would false-fire. It surfaces the
# risk in the Stop feedback and lets the human decide. (Files with only INLINE
# `!vault` encrypted vars are normal vars files and are intentionally ignored —
# we check whole-file vaults, identified by the `$ANSIBLE_VAULT` header.)
set -euo pipefail

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/ansible-lib.sh" 2>/dev/null \
  || . "$(dirname "$0")/ansible-lib.sh"

INPUT=$(cat)

if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0

ansible_quality_is_ansible_repo "$ROOT" || exit 0

YAML_FILES=$(ansible_quality_changed_yaml)
[ -z "$YAML_FILES" ] && exit 0

PLAINTEXT=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  base=$(basename "$f")
  # Treat as a whole-file vault only when the name/path strongly signals one.
  is_vault_named=false
  case "$base" in
    vault.yml|vault.yaml|vault_*|*-vault.yml|*-vault.yaml|*.vault.yml|*.vault.yaml|*_vault.yml|*_vault.yaml) is_vault_named=true ;;
  esac
  case "$f" in
    */vault/*) is_vault_named=true ;;
  esac
  $is_vault_named || continue
  # Encrypted vault files start with the `$ANSIBLE_VAULT;...` header.
  if ! head -c 14 "$f" 2>/dev/null | grep -q '\$ANSIBLE_VAULT'; then
    PLAINTEXT+=("$f")
  fi
done <<< "$YAML_FILES"

if [ ${#PLAINTEXT[@]} -gt 0 ]; then
  echo "WARNING: vault-named file(s) modified on this branch are NOT encrypted:" >&2
  for f in "${PLAINTEXT[@]}"; do
    echo "  - $f" >&2
  done
  echo "If these hold secrets, encrypt with: ansible-vault encrypt <file>  (or move secrets to an encrypted store). This is a warning, not a block." >&2
fi

exit 0
