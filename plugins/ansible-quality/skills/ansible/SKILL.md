---
name: ansible
description: This skill should be used when writing or reviewing Ansible
  playbooks, roles, tasks, handlers, vars, inventory, or vault files, or
  reasoning about ansible-lint rules/profiles and which ansible-core release
  introduced a behavior. Recent releases the model's training may predate —
  confirm against `ansible --version` / `ansible-lint --version` before
  assuming a behavior — ansible-core 2.19 shipped the "Data Tagging" templating
  overhaul (stricter templating; some templates that silently worked before now
  error, and origin/trust tagging replaces the old `unsafe` handling), and each
  recent core release raises the minimum control-node and target Python; modern
  ansible-lint exposes graduated profiles (min < basic < moderate < safety <
  shared < production) and an autofix (`ansible-lint --fix`) whose output shifts
  between versions.
example_prompts:
- review this Ansible role
- why is ansible-lint flagging command-instead-of-module
- how do I noqa a single ansible-lint rule
- is this task idempotent
- what changed in ansible-core templating recently
- how should I structure secrets with ansible-vault
permalink: tooling/claude-plugins/plugins/ansible-quality/skills/ansible/skill
---

# Ansible (ansible-core + ansible-lint)

<!-- Maintenance: when a new ansible-core minor or ansible-lint major ships,
update the recent-release line in the `description` above AND the sections
below, and verify against the changelogs:
  ansible-core: https://github.com/ansible/ansible/blob/devel/changelogs/CHANGELOG-v2.NN.rst
  ansible-lint: https://github.com/ansible/ansible-lint/releases -->

Reference for authoring Ansible that passes `ansible-lint` and `--syntax-check`.
For detail beyond the below, read the changelogs linked above.

## Recent behavior to confirm (training-cutoff hedge)

- **ansible-core 2.19 — Data Tagging.** A large templating internals change.
  Templating is stricter: some expressions that previously evaluated (often by
  silently stringifying or tolerating undefined) now raise. Trust/origin
  tagging replaces the older `unsafe` mechanism for marking untrusted data.
  If a playbook that worked on an older core throws new templating errors after
  an upgrade, suspect this. Verify the running version with `ansible --version`.
- **Python floor rises per release.** Each recent ansible-core minor raises the
  minimum Python for both the control node and managed targets. Check the
  support matrix for the version in use before assuming an older interpreter
  works.
- **ansible-lint profiles are graduated** — `min`, `basic`, `moderate`,
  `safety`, `shared`, `production` (strictest). `--profile production` is the
  release bar; a repo's `.ansible-lint` may pin a laxer one deliberately —
  that choice wins over any default.

## ansible-lint: profiles, config, and noqa

- **Honor the repo's `.ansible-lint`.** Its `profile`, `warn_list` (findings
  shown but non-fatal), `skip_list` (findings suppressed), and `exclude_paths`
  define the bar. Don't impose a stricter ruleset; aim for **no new findings on
  the files you changed**, not a repo-wide zero.
- **`# noqa` is the per-line escape hatch**, not global rule disabling:
  ```yaml
  - name: Read the current mount table   # noqa: command-instead-of-module
    ansible.builtin.command: mount
    changed_when: false
  ```
  Annotate the *specific* rule with a reason; never blanket-disable a rule in
  config to make one line pass.
- **`ansible-lint --fix`** autofixes many rules in place — but its output varies
  by version, so a local `--fix` can disagree with the project's pinned version
  and ping-pong against CI. Prefer the repo's pinned ansible-lint; let CI be
  authoritative on formatting.
- **`syntax-check` is an internal, non-skippable rule** — ansible-lint runs the
  playbook through ansible's parser, so a parse error fails lint regardless of
  profile.

## Idempotency cheatsheet (lint can't enforce this)

- Prefer a module over `command`/`shell`. When you must shell out, add
  `creates:`/`removes:` or honest `changed_when:`/`failed_when:`.
- A correct task reports `changed` only when it actually changes state; a second
  run should be all `ok`. `changed_when: false` is for read-only commands, not a
  way to silence a genuinely-changing task.
- Service state changes go through **handlers** (`notify:` → `handlers/`), not
  inline restarts every run. `meta: flush_handlers` forces pending handlers to
  run mid-play when ordering matters.

## FQCN and structure

- **FQCN everywhere**: `ansible.builtin.<module>`, `ansible.posix.*`,
  `community.general.*`. Bare module names (`copy:`, `command:`) fail
  `fqcn[action-core]`.
- **Role layout**: `defaults/main.yml` (documented, low-precedence vars),
  `vars/main.yml` (high-precedence), `tasks/`, `handlers/`, `templates/`,
  `meta/main.yml` (galaxy info + dependencies).
- **Static vs dynamic**: `import_*` is parse-time/static, `include_*` is
  runtime/dynamic. Tagged `include_tasks` needs `apply: { tags: [...] }` for the
  inner tasks to inherit the tag.

## ansible-vault (secrets)

- Encrypt a whole secrets file: `ansible-vault encrypt vault.yml` — encrypted
  files begin with a `$ANSIBLE_VAULT;1.x;AES256` header. Inspect without
  decrypting to disk: `ansible-vault view <file>`.
- Inline-encrypt a single value with `ansible-vault encrypt_string` and the
  `!vault |` tag inside an otherwise-plaintext vars file.
- The vault password (a key file or prompt) is **not** committed; a fresh
  checkout/worktree without it can't decrypt, so lint/syntax may fail to load
  vaulted vars — an environment gap, not a defect.
- Mark tasks that handle secrets `no_log: true` so values don't leak into output.

## Non-mutating CLI quick reference

```bash
ansible-lint <files>                         # lint changed files (repo config wins)
ansible-lint --profile production <files>    # strict bar (when repo ships no config)
ansible-playbook --syntax-check <playbook>   # parse-only; no host contact
ansible-playbook --check --diff -l <host> p  # dry-run a named host (asks first!)
ansible-vault view <file>                    # inspect an encrypted file
```
