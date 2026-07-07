---
name: tofu
description: This skill should be used when writing or reviewing OpenTofu or
  Terraform configs, modules, providers, lockfiles, or state backends — carrying
  both the authoring/review doctrine (module structure, provider/version
  pinning, for_each-over-count, moved-blocks over destructive renames, secret
  and state safety, the never-apply-to-live-infra rule, and the severity rubric
  shared by the tofu-developer and tofu-reviewer agents) and a recent OpenTofu
  release reference. Reach for it to reason about state-affecting diffs, secret
  leakage in outputs, or which tofu version introduced a feature.
permalink: tooling/claude-plugins/plugins/tofu-quality/skills/tofu/skill
---

# OpenTofu (tofu)

Knowledge base: tofu-quality/2026.07

<!-- Maintenance: when a new OpenTofu minor ships, update the three release
blocks in the "Recent Releases" section below (drop the oldest, add the newest;
bump the knowledge-base id when content meaningfully changes), verifying against
the per-version branch changelog (raw.githubusercontent.com/opentofu/opentofu/vX.Y/CHANGELOG.md). -->

Shared domain knowledge for authoring and reviewing OpenTofu/Terraform. The
tofu-developer applies it while writing HCL and driving the fmt/validate gates
to green; the tofu-reviewer applies it while critiquing a diff. Same knowledge,
two jobs. Where a project has adopted OpenTofu/Terraform without a deep house
corpus of past `.tf` authoring to imitate, lean on general OpenTofu/Terraform
best practices, lightly anchored to the project's tooling (your IaC repo, an
ephemeral assessment-VM template).

## Module-Structure Conventions

- **`variables.tf`** — typed variables with `description`s and sane defaults.
  Add `validation` blocks for constrained inputs (allowed values, CIDR shape,
  length). Mark secrets `sensitive = true`.
- **`outputs.tf`** — every output has a `description`; mark sensitive outputs
  `sensitive = true`.
- **`versions.tf`** — pin `required_version` honestly and pin each provider in
  `required_providers` with a version constraint. Prefer a pessimistic/range
  constraint (`~> 5.0`, or `>= 5.0, < 6.0`) over a bare exact pin (`5.0`) unless
  you have a specific reason to freeze. Commit `.terraform.lock.hcl` (it's the
  lockfile, not a cache — distinct from the gitignored `.terraform/`).
- **`for_each` over `count`** for keyed sets, so addressing stays stable when the
  set changes; `count` over a list re-indexes and churns every resource
  downstream on insertion/removal.
- **`moved {}` blocks** over destructive renames — refactor addresses without
  forcing a destroy/create.
- **Idempotency** — prefer native resources over `local-exec`; resources should
  converge on re-apply. Use `locals` for repeated expressions; avoid deeply
  nested `dynamic` blocks when a flatter form reads clearer.
- **Secrets** — never commit real secrets or a `.tfvars` with real values.
  Source secrets from a provider/data source (e.g. 1Password), not literals.
  Keep `*.tfvars` with real values out of git.

## Correctness & Hygiene

- Constrain every `variable` block with a `type` (and `validation` where the
  input is bounded); make implicit dependencies explicit with `depends_on` where
  needed.
- `lifecycle` blocks (`ignore_changes`) must not be so broad they mask real
  drift.
- Watch for plan-time side effects: `local-exec`/`remote-exec`/`external` data
  sources or `null_resource` that mutate the world during plan/apply; data
  sources with side effects.
- Drop dead variables/outputs; tag/label resources where the project
  standardizes them; keep naming consistent.

## What Matters in Review

Review from the handed diff; read the surrounding module to understand intent;
don't review the whole repo. Lead with anything state-affecting or
secret-leaking, then work the convention and hygiene sections above as the
checklist (pinning, for_each-vs-count, plan-time side effects, correctness,
hygiene). The review-only axes:

- **State-affecting / destructive diffs** — argument changes that force resource
  replacement (ForceNew), renames that destroy-and-recreate rather than move,
  removal of resources that drops live infrastructure. Highest severity; note
  the safer path (`moved` blocks, `create_before_destroy`).
- **Version-pin widening** — a loosened provider/module constraint that could
  pull a breaking major; `for_each` keys not known at plan time.
- **Secrets beyond the literals** — sensitive values landing in state, logs, or
  `local-exec` output, not just hardcoded in HCL/`.tfvars`.

## Safety Culture

The developer writes config and proves it's valid; it does **not** mutate live
infrastructure, and the reviewer runs nothing state-mutating (`apply`,
`destroy`, `import`, `state mv/rm`).

- **No `tofu apply` to live infra.** Author config and hand the change off;
  running `tofu apply` is the human's call.
- Before proposing any `destroy`, `-replace`, or `-target` operation, state the
  **state/data-at-risk reasoning** plainly — what gets destroyed/recreated and
  what data is lost — and get explicit confirmation. Don't bury a destructive
  plan in a green report.
- Never hand-edit state. Use `moved {}` / import / refactor, not state surgery.
- Show the `plan` and let the human decide before anything mutates
  infrastructure. A reviewer restricts any `tofu` run to read-only verbs
  (`fmt -check`, `validate`) — not `plan` against real state, never `apply`.

## Quality Gates & Tooling

The tofu-quality plugin ships PostToolUse/Stop hooks that run `tofu fmt` and
`tofu validate`. The authoring loop:

```bash
tofu fmt
tofu init -backend=false   # if the dir isn't initialized (fast, idempotent, no backend/creds)
tofu validate
tofu plan                  # only where a non-destructive target exists, to confirm intent
```

Treat `validate` failures as blocking — read the error and fix the cause, don't
just re-report it:

- **"Module not installed" / provider errors** → run `tofu init -backend=false`
  and re-validate.
- **Undefined variable / unknown attribute** → add the missing variable to
  `variables.tf` (typed, with a default where sensible) or fix the reference; a
  typo'd attribute usually means a wrong resource/block schema.
- **Version/constraint conflicts** → reconcile `required_providers` constraints
  with what the lockfile resolves; loosen an over-tight pin or update the lock.

Re-run `tofu fmt` + `tofu validate` after each fix until clean. If `validate`
can't run (offline, no provider cache, backend/creds needed), say so explicitly
rather than claiming it passed. **CI owns pure `tofu fmt` style** — a reviewer
shouldn't re-flag it.

## Severity Rubric

Rate every finding, give a `file:line`, and separate real risks from style
observations:

- **Critical** — a diff that destroys live infrastructure or forces destructive
  replacement without a `moved`/`create_before_destroy` path, or a secret
  hardcoded/leaked into an output or state.
- **High** — an unpinned/floating provider or module that can pull a breaking
  major, `count` index drift that will churn downstream resources, a plan-time
  side effect that mutates the world.
- **Medium** — unconstrained variables, overly broad `ignore_changes`, missing
  `depends_on`, an output missing `sensitive` where the value is borderline.
- **Low** — dead variables/outputs, naming/tagging inconsistency, style `tofu
  fmt` owns.

## Recent Releases (training-cutoff hedge)

Recent releases the model's training may predate — confirm against `tofu
version` / `required_version` before assuming a feature is absent. For detail
beyond the below, read the notes: <https://github.com/opentofu/opentofu/releases>.

**v1.12** — `prevent_destroy` can now be dynamic (reference other symbols in
the same module). `tofu init` records a full set of provider checksums for
*all* supported platforms in `.terraform.lock.hcl`, so cross-platform lockfiles
no longer need `tofu providers lock -platform=...`. The new `-json-into=<file>`
argument emits human-readable logs to the terminal and machine-readable logs to
a file at the same time.

**v1.11** — Ephemeral values: input variables, outputs, and resources can be
marked ephemeral so they never persist to state or plan files, and providers
can expose write-only attributes. The `enabled` meta-argument (inside a
`lifecycle` block) is a cleaner alternative to `count`/`for_each` when a
resource or module should have zero or one instance.

**v1.10** — OCI registry support for module packages and provider mirrors (the
`oci:` source scheme). Native S3 state locking via `use_lockfile = true` (no
DynamoDB table required). Partial OpenTelemetry tracing to a collector you
control. `-target-file` / `-exclude-file` for targeting resources from a file.

### Deprecation warnings

The `winrm` connection type (remote-exec/file provisioners) is deprecated in
1.12 and removed in 1.13; `OPENTOFU_USER_AGENT` was removed in 1.12; the
`azurerm` backend's `endpoint`/`msi_endpoint` args were deprecated in 1.11.

### Compatibility notes

1.12 is the last series to support macOS 12 Monterey; 1.10 raised platform
minimums (Linux kernel 3.2+, macOS 11+) and changed the PostgreSQL backend
locking implementation (incompatible with older state locks) — check the OS and
backend notes for the target version before upgrading a deployment.
