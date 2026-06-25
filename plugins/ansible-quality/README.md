# ansible-quality

Ansible quality gates. On Stop / SubagentStop / TaskCompleted / TeammateIdle,
three checks run against the Ansible YAML modified on the current branch:

1. **Lint** (`ansible-lint`) — **blocks** (exit 2) on real rule violations in
   the modified files. Honors the repo's own `.ansible-lint` config (profile,
   `warn_list`, `skip_list`); only imposes `--profile production` when the repo
   ships no ansible-lint config of its own. This gate also covers syntax (it
   runs ansible's parser internally).
2. **Syntax check** (`ansible-playbook --syntax-check`) — **blocks** on genuine
   parse errors in modified **playbooks**. A lighter-weight backstop that still
   runs when the richer lint env is degraded, and catches breakage a lax lint
   profile might have disabled.
3. **Vault plaintext check** — **warn-only** (never blocks). Flags a
   vault-named file (`vault.yml`, `vault_*`, `*-vault.yml`, anything under a
   `vault/` dir) that isn't `$ANSIBLE_VAULT`-encrypted, in case a plaintext
   secrets file slipped in.

All gates are **diff-scoped**: they act only on `.yml` / `.yaml` files modified
in the working tree, staged, or on the current branch vs. its merge-base with
`main`/`master`. Galaxy-installed `collections/`, `.cache/`, and nested
`worktrees/` are excluded, and a `stop_hook_active` guard prevents infinite Stop
loops. Diff-scoping is essential here — an Ansible repo typically carries
pre-existing lint debt, so a repo-wide gate would false-block every turn.

## Why the gates warn-skip on a broken lint env (and don't false-block)

`ansible-lint` rides on `ansible-core` + Python + installed collections — a much
more fragile base than a single `tofu`/`gofmt` binary. A repo can be perfectly
correct yet ansible-lint still errors because a collection isn't installed
(*"couldn't resolve module/action 'ansible.posix.mount'"*), a Python import is
broken (`ModuleNotFoundError`), or vaulted vars can't be decrypted (no
`vault.key`). Those are **environment gaps, not code defects**, so blocking on
them would false-fire constantly.

Each gate therefore distinguishes:

- **Real rule violation / syntax error** → **block** (exit 2).
- **Tooling/environment failure** (missing collection, broken Python/ansible
  env, undecryptable vault, ansible-lint crash) → **warn-skip** (exit 0 with a
  one-line note). The lint and syntax gates recognize these by signature in the
  tool output and skip rather than block.
- **Clean** → pass.

This mirrors `tofu-quality`'s init-gating philosophy: block only on genuine code
defects, never on an environment the hook can't fully provision.

## No auto-format on edit (deliberate)

Unlike `go-quality`/`tofu-quality`, there is **no `PostToolUse` auto-format**.
`ansible-lint --fix` is the closest equivalent to `gofmt -w`, but its autofix
output shifts between ansible-lint versions: if your local version differs from
the project's pinned one, an auto-fix-on-save would ping-pong against CI (the
same version-skew trap that bites tool-based formatters with non-deterministic
output). So this plugin **checks but never rewrites**. If you want to autofix,
run `ansible-lint --fix` yourself with the repo's pinned version.

## Dormant outside Ansible repos

This is a portable plugin and may be enabled globally. Every gate self-gates on
the repo actually being an Ansible project (it looks for `ansible.cfg`,
`.ansible-lint`, `galaxy.yml`, or a conventional `playbooks/` / `roles/` /
`inventory` / `group_vars` / `host_vars` dir). In a repo with none of those, the
gates exit silently and the SessionStart probe stays quiet — no nagging about
missing tools in a repo that has no Ansible.

## `ansible-developer` agent

A full-lifecycle authoring agent: it plans, writes idempotent playbooks/roles,
and drives `ansible-lint` + `--syntax-check` to green, then opens a PR for
review. It owns the things the gates can't check (idempotency, FQCN, `# noqa`
discipline, vault hygiene) and never runs plays against live hosts. See
`agents/ansible-developer.md`.

## `/ansible` skill

A reference skill whose **description is always in context**, carrying a
one-line hedge about recent `ansible-core` / `ansible-lint` behavior the model's
training may predate (e.g. the 2.19 "Data Tagging" templating overhaul). Invoke
`/ansible` to load the fuller body: the recent-release notes plus a durable
cheatsheet for ansible-lint profiles/`noqa`, idempotency, FQCN/role structure,
and `ansible-vault`.

Keep it current: when a new `ansible-core` minor or `ansible-lint` major lands,
update the recent-behavior line in the skill `description` and the matching body
section.

## Claude Code Web

In Claude Code Web (`CLAUDE_CODE_REMOTE=true`), the `SessionStart` hook
best-effort installs `ansible-lint` (which pulls `ansible-core`, providing
`ansible-playbook`) and `jq`. Note: unlike `tofu`/`go` (single static binaries),
`ansible-lint` is a **pip install with a real dependency tree** — heavier,
slower, and may fail offline. The gates are built to warn-skip when it does, so
a failed install degrades gracefully rather than breaking the session.

## Bounded check output

On a lint/syntax failure, the full tool output is written to a log file and only
the first **N lines** are emitted to the Stop feedback, followed by a footer
pointing at the log and a reproduce command — so the feedback isn't flooded
every turn.

- **N** defaults to **200**. Override via the `CLAUDE_QUALITY_MAX_LINES` env var
  (or the `CLAUDE_PLUGIN_OPTION_MAX_LINES` plugin option, if your host exposes
  one).
- **Log location**: `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/{id}/`),
  falling back to `${TMPDIR:-/tmp}`. Logs are named `ansible-lint.log` and
  `syntax-<playbook-slug>.log`.

## Requirements

- [`ansible-lint`](https://ansible.readthedocs.io/projects/lint/) — `pipx install ansible-lint` (pulls `ansible-core`); macOS: `brew install ansible-lint`
- `ansible-playbook` (from `ansible-core`) — used by the syntax-check gate
- `jq` — used by the hooks to parse hook stdin (the `stop_hook_active` loop guard)

If a tool is missing the gates degrade gracefully (skip with a warning) rather
than erroring; in an Ansible repo the `SessionStart` probe reports what's
degraded.
