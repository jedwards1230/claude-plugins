---
name: tofu
description: |
  OpenTofu (tofu) reference — use when writing or reviewing OpenTofu/Terraform configs, version constraints, providers, or lockfiles. Recent releases (training may predate these — don't assume):
  - v1.12 — dynamic prevent_destroy, all-platform provider lockfile checksums, simultaneous human- + machine-readable output (-json-into)
  - v1.11 — ephemeral values & write-only attributes, the `enabled` meta-argument
  - v1.10 — OCI registry support, native S3 state locking (use_lockfile), OpenTelemetry tracing, -target-file/-exclude-file
  Confirm `tofu version` and the config's required_version before assuming a feature exists.
---

# OpenTofu (tofu)

Recent-release reference. The 3 latest minor releases live in this skill's
`description` (always in context, since the model's training may predate them).
This body adds a sentence or two per release plus deprecation/compatibility
notes. For anything beyond this, read the release notes directly:
<https://github.com/opentofu/opentofu/releases>.

## Recent releases

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

## Deprecation warnings

The `winrm` connection type (remote-exec/file provisioners) is deprecated in
1.12 and removed in 1.13; `OPENTOFU_USER_AGENT` was removed in 1.12; the
`azurerm` backend's `endpoint`/`msi_endpoint` args were deprecated in 1.11.

## Compatibility notes

1.12 is the last series to support macOS 12 Monterey; 1.10 raised platform
minimums (Linux kernel 3.2+, macOS 11+) and changed the PostgreSQL backend
locking implementation (incompatible with older state locks) — check the OS and
backend notes for the target version before upgrading a deployment.

## More

Read the relevant tag at <https://github.com/opentofu/opentofu/releases> when
you need detail beyond the above — especially before raising a `required_version`
floor or bumping a provider major version.
