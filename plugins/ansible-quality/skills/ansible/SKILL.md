---
name: ansible
description: This skill should be used when writing or reviewing Ansible
  playbooks, roles, tasks, handlers, vars, inventory, or vault files — carrying
  both the authoring/review doctrine (idempotency culture, FQCN, handler wiring,
  check-mode safety, secret handling, the run-nothing-against-live-hosts safety
  rule, environment gotchas, and the severity rubric shared by the
  ansible-developer and ansible-reviewer agents) and a recent ansible-core /
  ansible-lint release reference. Reach for it to reason about ansible-lint
  rules/profiles, whether a task is idempotent, no_log/vault secret handling, or
  which ansible-core release introduced a behavior.
permalink: tooling/claude-plugins/plugins/ansible-quality/skills/ansible/skill
---

# Ansible (ansible-core + ansible-lint)

Knowledge base: ansible-quality/2026.07

<!-- Maintenance: when a new ansible-core minor or ansible-lint major ships,
update the "Recent Behavior to Confirm" section below (and bump the
knowledge-base id when content meaningfully changes), verifying against:
  ansible-core: https://github.com/ansible/ansible/blob/devel/changelogs/CHANGELOG-v2.NN.rst
  ansible-lint: https://github.com/ansible/ansible-lint/releases -->

Shared domain knowledge for authoring and reviewing Ansible. The
ansible-developer applies it while writing playbooks/roles and driving the
lint/syntax gates to green; the ansible-reviewer applies it while critiquing a
diff. Same knowledge, two jobs. Lint and syntax-check validate *structure*, not
*behavior* — a playbook can be lint-clean and syntax-valid yet non-idempotent or
wrong at runtime, so the doctrine below carries the weight the tools can't.

## Idempotency Culture (lint can't enforce this)

- Every task should converge: a second run reports `ok`, not `changed`. Prefer a
  purpose-built module over `command`/`shell`.
- When you must use `command`/`shell`/`raw`, make it honest: add
  `creates:`/`removes:` or `changed_when:`/`failed_when:` so it doesn't lie about
  its change state. `changed_when: false` is for read-only commands — never a way
  to silence a genuinely-changing task.
- Service state changes go through **handlers** (`notify:` → `handlers/`), not
  inline restarts every run. `notify` names must match a defined handler
  exactly; handlers must themselves be idempotent; `meta: flush_handlers` forces
  pending handlers to run mid-play when ordering matters.

## FQCN and Structure

- **FQCN everywhere**: `ansible.builtin.<module>`, `ansible.posix.*`,
  `community.general.*`. Bare module names (`copy:`, `command:`) fail
  `fqcn[action-core]`.
- **Role layout**: `defaults/main.yml` (documented, low-precedence vars),
  `vars/main.yml` (high-precedence), `tasks/`, `handlers/`, `templates/`,
  `meta/main.yml` (galaxy info + dependencies).
- **Task hygiene**: every task has a `name:`; `block:`/`rescue:`/`always:` for
  grouped error handling; `loop:` (not `with_*`); readable `when:` conditions;
  consistent tags.
- **Static vs dynamic**: `import_*` is parse-time/static, `include_*` is
  runtime/dynamic. Tagged `include_tasks` needs `apply: { tags: [...] }` (and
  often `loop`) for the inner tasks to inherit the tag.

## Variables & Templating

- Guard undefined-variable risk; use `default()` where appropriate; quote a
  `{{ }}` at the start of a value; apply `| bool`/`| int` filters; don't rely on
  deprecated bare-variable conditionals.
- Be mindful of ansible-core 2.19's stricter templating (Data Tagging), where
  some previously-silent templates now error (see release reference below).

## Secrets & no_log

- Never commit plaintext secrets. Vault-encrypt secret files (`ansible-vault
  encrypt`) or source from an external store; keep secrets out of `register`ed
  results and `debug` output.
- Mark any task that handles a secret `no_log: true` so values don't leak into
  stdout or logs.
- Encrypt a whole secrets file: `ansible-vault encrypt vault.yml` — encrypted
  files begin with a `$ANSIBLE_VAULT;1.x;AES256` header. Inspect without
  decrypting to disk: `ansible-vault view <file>`. Inline-encrypt a single value
  with `ansible-vault encrypt_string` and the `!vault |` tag inside an otherwise
  plaintext vars file.
- The vault password (a key file or prompt) is **not** committed; a fresh
  checkout/worktree without it can't decrypt, so lint/syntax may fail to load
  vaulted vars — an environment gap, not a defect.

## Privilege & Check-Mode Safety

- Scope `become` to the tasks that need it, not blanket play-level when
  avoidable. Set file `mode` as a quoted string. Guard destructive tasks
  (`file: state=absent`, `command: rm`) with conditions.
- Check-mode: tasks that break or lie under `--check` (`command`/`shell` without
  `check_mode`/`changed_when` handling) are a defect. `check_mode: false` only
  where genuinely needed (read-only fact gathering), not as a blanket escape.

## ansible-lint: Profiles, Config, and noqa

- **Honor the repo's `.ansible-lint`.** Its `profile`, `warn_list` (findings
  shown but non-fatal), `skip_list` (findings suppressed), and `exclude_paths`
  define the bar. Don't impose a stricter ruleset; don't fix pre-existing debt
  outside your change or tighten rules the repo deliberately relaxed. Aim for
  **no new findings on the files you changed**, not a repo-wide zero.
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

## What Matters in Review

Review from the handed diff; read the surrounding role to learn its conventions
before judging; don't review the whole repo. Work the sections above as the
checklist, in priority order: secret handling first, then idempotency, FQCN,
check-mode safety, handler wiring, variables & templating (incl. 2.19 Data
Tagging), privilege & safety, structure. One review-only note: a changed task
that *should* notify a restart but doesn't is a finding, not just a mismatched
`notify` name.

## Safety Culture (authoring)

The developer writes config and proves it parses/lints; it does **not** run
plays against live hosts, and the reviewer runs nothing mutating at all.

- **No `ansible-playbook` against live infrastructure.** Author the change and
  hand it off; running the play is the human's call. If a live run is genuinely
  needed to validate, hand it back to the human to run in their main session —
  don't run it buffered inside an agent context.
- The only ansible to run is **non-mutating**: `ansible-lint`, `ansible-playbook
  --syntax-check`, and at most `--check --diff` against an explicitly-named
  limit when the user asks. Never a `--limit`-less run.
- Before proposing anything destructive (stops services, wipes data, reboots,
  partitions disks), state the **blast radius** plainly — which hosts, what
  changes, what's at risk — and get explicit confirmation. Don't bury it in a
  green report.

## Environment Gotchas

- **Run ansible from the right cwd.** ansible loads `ansible.cfg` (and thus
  inventory) from the current directory; running from the wrong dir silently
  yields an empty inventory that *looks* like a clean result. Run lint/syntax
  from the repo root (where `ansible.cfg` lives), and never trust an "empty"
  result that might just be a lost inventory.
- **A broken lint env is common, not exceptional.** ansible-lint rides on
  ansible-core + Python + installed collections; a missing collection or version
  mismatch makes it error on correct config. If lint/syntax can't run cleanly,
  report it as an environment gap — don't claim the code is wrong, and don't
  claim it's clean.
- **Tool version skew** — if a local `ansible-lint --fix` differs from what's
  committed, your local version disagrees with the project's pinned one. Don't
  fight it locally; let CI's pinned version be authoritative.

## Severity Rubric

Rate every finding, give a `file:line`, and separate real bugs from style
observations. Lead with anything that leaks a secret or is destructively
non-idempotent:

- **Critical** — a secret leaked (hardcoded, or echoed via missing `no_log`), or
  a destructive/non-idempotent task that can damage a host on rerun.
- **High** — a non-idempotent `command`/`shell` that reports false changes or
  breaks under `--check`, a broken handler notify (restart never fires),
  unscoped `become` on a destructive path.
- **Medium** — missing FQCN, undefined-variable risk, weak templating guards,
  structural/precedence issues.
- **Low** — naming, tags, and pure formatting that `ansible-lint --fix` / CI
  owns (don't re-flag unless it masks a real issue).

## Recent Behavior to Confirm (training-cutoff hedge)

Recent releases the model's training may predate — confirm against `ansible
--version` / `ansible-lint --version` before assuming a behavior.

- **ansible-core 2.19 — Data Tagging.** A large templating internals change.
  Templating is stricter: some expressions that previously evaluated (often by
  silently stringifying or tolerating undefined) now raise. Trust/origin tagging
  replaces the older `unsafe` mechanism for marking untrusted data. If a playbook
  that worked on an older core throws new templating errors after an upgrade,
  suspect this.
- **Python floor rises per release.** Each recent ansible-core minor raises the
  minimum Python for both the control node and managed targets. Check the support
  matrix for the version in use before assuming an older interpreter works.
- **ansible-lint profiles are graduated** — `min`, `basic`, `moderate`,
  `safety`, `shared`, `production` (strictest). `--profile production` is the
  release bar; a repo's `.ansible-lint` may pin a laxer one deliberately — that
  choice wins over any default.

## Non-mutating CLI Quick Reference

```bash
ansible-lint <files>                         # lint changed files (repo config wins)
ansible-lint --profile production <files>    # strict bar (when repo ships no config)
ansible-playbook --syntax-check <playbook>   # parse-only; no host contact
ansible-playbook --check --diff -l <host> p  # dry-run a named host (asks first!)
ansible-vault view <file>                    # inspect an encrypted file
```
