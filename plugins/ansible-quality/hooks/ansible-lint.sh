#!/bin/bash
# Lint the Ansible YAML modified on this branch with ansible-lint, mirroring CI.
#
# Why this gate WARN-SKIPS on a broken lint env (the central design choice):
#   ansible-lint sits on top of ansible-core + Python + installed collections,
#   any of which can be missing or mismatched in a dev container — a far more
#   fragile base than a single `tofu`/`gofmt` binary. A repo can be perfectly
#   correct yet ansible-lint still errors because `ansible.posix` isn't
#   installed ("couldn't resolve module/action"), a Python import is broken
#   (ModuleNotFoundError / ansible.parsing.yaml.constructor), or vaulted vars
#   can't be decrypted (no vault.key). Those are ENVIRONMENT gaps, not code
#   defects, so blocking on them would false-fire constantly. This hook
#   therefore distinguishes:
#     - real rule violations (exit 2, no env signature) -> BLOCK (exit 2)
#     - tooling/env failure (any env signature, or a crash RC)  -> WARN-SKIP (exit 0)
#     - clean                                              -> pass (exit 0)
#
# It is also DIFF-SCOPED (only YAML changed on this branch) and honors the
# repo's own .ansible-lint config — the repo carries pre-existing lint debt we
# deliberately don't fix, so a repo-wide gate would false-block. The repo's
# profile/warn_list/skip_list WINS; we only impose `--profile production` when
# the repo ships no ansible-lint config of its own.
set -euo pipefail

# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/quality-emit.sh" 2>/dev/null \
  || . "$(dirname "$0")/quality-emit.sh"
# shellcheck source=/dev/null
. "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/hooks/ansible-lib.sh" 2>/dev/null \
  || . "$(dirname "$0")/ansible-lib.sh"

INPUT=$(cat)

# Loop guard — don't re-fire while a Stop hook is already keeping Claude going.
if command -v jq &>/dev/null; then
  if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)" = "true" ]; then
    exit 0
  fi
fi

if ! command -v ansible-lint &>/dev/null; then
  echo "WARNING: ansible-lint not found in PATH — skipping Ansible lint" >&2
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0

# Portable plugin: stay silent unless this is actually an Ansible project.
ansible_quality_is_ansible_repo "$ROOT" || exit 0

YAML_FILES=$(ansible_quality_changed_yaml)
[ -z "$YAML_FILES" ] && exit 0

# Only lint files that still exist on disk (a deleted file is in the diff).
FILES=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] && FILES+=("$f")
done <<< "$YAML_FILES"
[ ${#FILES[@]} -eq 0 ] && exit 0

# Repo config wins. Only force a profile when the repo ships none of its own,
# so we never override a repo that deliberately chose a laxer profile.
PROFILE_ARGS=()
if [ ! -f .ansible-lint ] && [ ! -f .ansible-lint.yml ] && [ ! -f .ansible-lint.yaml ] \
   && [ ! -f .config/ansible-lint.yml ] && [ ! -f .config/ansible-lint.yaml ]; then
  PROFILE_ARGS=(--profile production)
fi

# Batch every changed file into a single invocation (not one run per file).
set +e
# ${PROFILE_ARGS[@]+...} guards the empty-array case under `set -u` on bash 3.2
# (macOS), where a bare "${PROFILE_ARGS[@]}" on an empty array is "unbound".
OUT=$(ansible-lint --nocolor ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} -- "${FILES[@]}" 2>&1)
RC=$?
set -e

[ "$RC" -eq 0 ] && exit 0

# Environment-gap signatures — these mean "ansible-lint couldn't run cleanly
# here", NOT "your playbook is wrong". Warn-skip on any of them, even when the
# exit code is 2 (an unresolved collection is reported as a violation).
ENV_SIGNATURES='ModuleNotFoundError|Traceback \(most recent call last\)|ansible\.parsing\.yaml\.constructor|resolve module/action|not find or access|collections? (were|was) not found|Attempting to decrypt|Decryption failed|no vault secrets|vault password|Unable to load|Failed to load the plugin'

if printf '%s\n' "$OUT" | grep -qE "$ENV_SIGNATURES"; then
  echo "note: ansible-lint skipped — its environment can't run cleanly here (missing collection, broken Python/ansible env, or undecryptable vault). This is an environment gap, not a code defect; run 'ansible-lint ${FILES[*]}' in a working env to see real findings." >&2
  exit 0
fi

if [ "$RC" -eq 2 ]; then
  echo "ansible-lint found issues in modified files:" >&2
  printf '%s\n' "$OUT" | emit_bounded "ansible-lint.log" "ansible-lint ${FILES[*]}"
  exit 2
fi

# Any other non-zero RC is an ansible-lint crash, not a rule violation.
echo "note: ansible-lint exited with code $RC (tooling error, not a lint finding) — skipping. Re-run: ansible-lint ${FILES[*]}" >&2
exit 0
