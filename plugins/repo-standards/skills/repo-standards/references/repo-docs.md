# Repo docs — README / CONTRIBUTING / CLAUDE.md

Beyond settings and rulesets, a repo's three top-level docs each own a distinct job. Keep them
non-overlapping. (This file owns the *split* between the three root docs; `knowledge-base.md` owns
what sits underneath — CLAUDE.md as a map, the `docs/` minimum, invariants, authority boundaries,
and hub-and-spoke package docs.)

| File | Audience / job | Owns |
|------|----------------|------|
| `README.md` | users / consumers | what it is, install/quickstart/usage, badges, license, a short `## Contributing` link |
| `CONTRIBUTING.md` | anyone contributing (human **or** agent) | prerequisites, **build/test/lint**, before-you-open-a-PR, branching/commits, PR flow, releases, doc upkeep |
| `CLAUDE.md` | anyone working *in* the code | architecture, module map, conventions, gotchas, and only **codebase-unique** commands (run/serve, deploy/musl, single-package test) |

## Rules that keep them from drifting back into duplication

- **`CLAUDE.md` `@import`s `CONTRIBUTING.md`** — the `@CONTRIBUTING.md` line goes **immediately after
  CLAUDE.md's H1 title** (the H1 stays the first line; the import is the next content line, NOT above
  the title). That single import is the *only* link between the two; CLAUDE.md does **not** restate
  build/test/lint (delete that block — don't leave a "see CONTRIBUTING.md" pointer; the import already
  injects it).
- **Delete the build/test/lint duplication *only* — keep run/serve/deploy/ops commands.** CLAUDE.md
  still owns codebase-unique *operational* commands: how to run/serve/deploy the thing, run a single
  package's tests, requeue a job, exec into the daemon. Litmus: a "how do I **build/test/lint before a
  PR**" command moves to CONTRIBUTING; a "how do I **run/operate** this code" command stays. Deleting
  the whole `## Commands` section is a common over-trim — e.g. an ops repo lost its `ansible-playbook
  --limit/--tags/--check` and cluster-ops examples along with the lint block and drew a blocking review.
- **No doc references `CLAUDE.md` — at all.** Not README, not CONTRIBUTING, not `docs/**`. CLAUDE.md
  is agent/working context, not canonical documentation, so a "see CLAUDE.md for X" pointer from any
  doc is forbidden — **inline the content instead**. (A bare filename in a changelog/files-touched
  manifest is a record, not a pointer, and is fine.)
- **`CONTRIBUTING.md` is the single canonical home** for build/test/lint and the PR/release process.
  Copy commands **verbatim from CI** — never invent them.
- **One set of rules for all contributors.** No "for AI agents" section; never distinguish humans
  from agents anywhere.
- **`README.md`** gets a short `## Contributing` link to CONTRIBUTING; trim contributor-only checks
  (test/fmt/lint) out of any user-facing "build" section, leaving only deploy/artifact steps.

## CONTRIBUTING.md baseline

A fill-in template lives at `../templates/CONTRIBUTING.template.md` (next to the ruleset class JSONs).
Copy it to the repo root, fill the `<…>` placeholders from the repo's own CI + CLAUDE.md (ground
truth), and keep only the `[conditional]` blocks that apply:

| Section / block | Include when |
|-----------------|--------------|
| Prerequisites → devcontainer note | the repo has a `.devcontainer/` |
| Before you open a PR → `pre-commit run --all-files` | the repo has a `.pre-commit-config.yaml` |
| Before you open a PR → blocking-gate note | a Stop hook (or similar) blocks commits locally |
| Pull requests → automated-review line | the repo runs an automated PR review (e.g. a Claude review workflow) on pull requests |
| Releases → variant A / B / C | A = opt-in `semver:*` label (versioned artifact); B = no versioned release (continuous-deploy / GitOps / ops); C = bespoke (describe + link the workflow) |

The "Pull requests" merge line should match what the ruleset class actually enforces: Class A/B
require a PR + **all review threads resolved** (approvals are `0`), so say *"merged once CI is green
and all review threads are resolved"* — not "approved".

## Applying to a repo

1. Copy `../templates/CONTRIBUTING.template.md` → repo-root `CONTRIBUTING.md`; fill placeholders from CI/CLAUDE.md.
2. Add `@CONTRIBUTING.md` to `CLAUDE.md` on the line **right after its H1 title** (the H1 stays first — do NOT make the import line 1); delete CLAUDE.md's now-duplicated build/test/lint block — **only** that block (keep run/serve/deploy/ops commands; see the over-trim rule above).
3. Add a `## Contributing` link to `README.md`; remove any doc→CLAUDE.md pointers.
4. Branch `docs/add-contributing`, Conventional + signed commit, open a PR; never merge.
