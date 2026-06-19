# shellcheck shell=bash
# Shared helpers for the ansible-quality Stop-family hooks.
#
# NOTE: this file is specific to ansible-quality (unlike quality-emit.sh, which
# is byte-identical across all *-quality plugins). It carries the two pieces of
# logic all three gates share: deciding whether the repo is even an Ansible
# project, and collecting the YAML files modified on this branch.

# Is the current repo an Ansible project at all? This plugin is portable and may
# be enabled globally, so the gates must stay SILENT in non-Ansible repos rather
# than linting every stray .yml (CI workflows, k8s manifests, compose files).
# Heuristic: a root-level marker, OR any conventional ansible dir/ on disk.
ansible_quality_is_ansible_repo() {
  local root="$1"
  [ -f "$root/ansible.cfg" ] && return 0
  [ -f "$root/.ansible-lint" ] && return 0
  [ -f "$root/.ansible-lint.yml" ] && return 0
  [ -f "$root/.ansible-lint.yaml" ] && return 0
  [ -f "$root/galaxy.yml" ] && return 0
  # requirements.yml at root is ambiguous (pip uses it too); require a sibling
  # roles/ or collections/ to treat it as an Ansible signal.
  for d in playbooks roles inventory group_vars host_vars; do
    [ -d "$root/$d" ] && return 0
  done
  return 1
}

# Emit (newline-separated) the .yml/.yaml files modified in the working tree,
# staged, or on this branch vs its merge-base with main/master. Excludes the
# dirs that are never hand-authored ansible: galaxy-installed collections,
# molecule scenarios' caches, nested worktrees, and VCS internals.
ansible_quality_changed_yaml() {
  local base="" candidate modified
  for candidate in main master; do
    base=$(git merge-base HEAD "$candidate" 2>/dev/null || true)
    [ -n "$base" ] && break
  done

  modified=$(
    {
      git diff --name-only 2>/dev/null || true
      git diff --name-only --cached 2>/dev/null || true
      [ -n "$base" ] && git diff --name-only "$base" HEAD 2>/dev/null || true
    } | sort -u
  )
  [ -z "$modified" ] && return 0

  printf '%s\n' "$modified" \
    | grep -E '\.(yml|yaml)$' \
    | grep -v '/\.cache/' \
    | grep -v '/collections/ansible_collections/' \
    | grep -v '/worktrees/' | grep -v '^worktrees/' \
    | grep -v '/\.git/' || true
}
