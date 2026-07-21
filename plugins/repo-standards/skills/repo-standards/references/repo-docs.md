# Repo docs — README / CONTRIBUTING / AGENTS.md / CLAUDE.md

Beyond settings and rulesets, a repo's root docs each own a distinct job. Keep them
non-overlapping. (This file owns the *split* between the root docs; `knowledge-base.md` owns
what sits underneath — the agent map, the `docs/` minimum, invariants, authority boundaries,
and hub-and-spoke package docs.)

| File | Audience / job | Owns |
|------|----------------|------|
| `README.md` | users / consumers | what it is, install/quickstart/usage, badges, license, a short `## Contributing` link |
| `CONTRIBUTING.md` | anyone contributing (human **or** agent) | prerequisites, **build/test/lint**, before-you-open-a-PR, branching/commits, PR flow, releases, doc upkeep |
| `AGENTS.md` *(optional)* | any coding agent, any vendor | architecture, module map, conventions, gotchas, and only **codebase-unique** commands (run/serve, deploy/musl, single-package test) — **canonical when present** |
| `CLAUDE.md` | Claude Code | **either** that same canonical content (no `AGENTS.md`) **or** a thin wrapper importing it (when `AGENTS.md` exists) |

Exactly one file is the **canonical agent file** — `AGENTS.md` if the repo has one, otherwise
`CLAUDE.md`. Everything `knowledge-base.md` says about the map applies to whichever that is.

## The mechanic that drives everything

`@import` is a **CLAUDE.md memory feature, not a markdown convention**. Claude Code reads
`CLAUDE.md`, not `AGENTS.md` ([memory docs](https://code.claude.com/docs/en/memory)) — so
`@CONTRIBUTING.md` in `CLAUDE.md` *injects the whole contributing doc into context*, while the same
line in `AGENTS.md` is inert text to every other agent tool that reads that file. Two consequences,
and they are the whole design:

- **Imports live only in `CLAUDE.md`.** `AGENTS.md` stays portable plain markdown and links with
  ordinary relative markdown links.
- **The wrapper direction is one-way:** `CLAUDE.md` → `AGENTS.md`, never the reverse. `AGENTS.md`
  never mentions `CLAUDE.md` — the wrapper holds nothing canonical worth pointing at.

## The two shapes

**Shape 1 — no `AGENTS.md`** (the default; staying here is fine). `CLAUDE.md` *is* the canonical
agent file and carries the import on the line right after its H1 — see
`../templates/CLAUDE.template.md`:

```markdown
# CLAUDE.md

@CONTRIBUTING.md

…purpose, invariants, routing index, run/ops commands…
```

**Shape 2 — `AGENTS.md` exists.** `AGENTS.md` becomes canonical (portable across agent vendors);
`CLAUDE.md` shrinks to a wrapper that imports it **and** CONTRIBUTING — that wrapper is the only
reason Claude Code sees either file:

```markdown
# CLAUDE.md

@AGENTS.md
@CONTRIBUTING.md
```

`AGENTS.md` then carries the whole template body (minus the import), and points at CONTRIBUTING with
a plain link instead:

```markdown
Build, test, and lint commands live in [CONTRIBUTING.md](CONTRIBUTING.md).
```

Nothing else belongs in the wrapper except the one optional extra eager import `knowledge-base.md`
allows, and genuinely Claude-Code-specific instructions (plan-mode policy, which skills to prefer)
below the imports — anything another agent would also need belongs in `AGENTS.md`.

> **Don't symlink `CLAUDE.md` → `AGENTS.md`.** It's a documented alternative in general, but it
> can't also carry the `@CONTRIBUTING.md` import and leaves nowhere for Claude-specific additions.

## Rules that keep them from drifting back into duplication

- **`CLAUDE.md` carries the import(s), immediately after its H1 title** — the H1 stays the first
  line; the import(s) are the next content line(s), NOT above the title. Shape 2's order is
  `@AGENTS.md` then `@CONTRIBUTING.md`. Those imports are the *only* link between these files; the
  canonical agent file does **not** restate build/test/lint (delete that block — don't leave a "see
  CONTRIBUTING.md" pointer; the import already injects it).
- **Never put an `@import` in `AGENTS.md`.** It would expand for Claude (imports recurse up to four
  hops) but read as a dangling stray line in every other tool — use a markdown link instead.
- **Delete the build/test/lint duplication *only* — keep run/serve/deploy/ops commands.** The
  canonical agent file still owns codebase-unique *operational* commands: how to run/serve/deploy the
  thing, run a single package's tests, requeue a job, exec into the daemon. Litmus: a "how do I
  **build/test/lint before a PR**" command moves to CONTRIBUTING; a "how do I **run/operate** this
  code" command stays. Deleting the whole `## Commands` section is a common over-trim — e.g. an ops
  repo lost its `ansible-playbook --limit/--tags/--check` and cluster-ops examples along with the lint
  block and drew a blocking review.
- **No doc references `CLAUDE.md` — at all.** Not README, not CONTRIBUTING, not `AGENTS.md`, not
  `docs/**`. CLAUDE.md is agent/working context (and in Shape 2, just a wrapper), so a "see CLAUDE.md
  for X" pointer from any doc is forbidden — **inline the content instead**, or point at `AGENTS.md`
  when that's where it lives. (A bare filename in a changelog/files-touched manifest is a record, not
  a pointer, and is fine.)
- **`CONTRIBUTING.md` is the single canonical home** for build/test/lint and the PR/release process.
  Copy commands **verbatim from CI** — never invent them.
- **One set of rules for all contributors.** No "for AI agents" section; never distinguish humans
  from agents anywhere.
- **`README.md`** gets a short `## Contributing` link to CONTRIBUTING; trim contributor-only checks
  (test/fmt/lint) out of any user-facing "build" section, leaving only deploy/artifact steps.

## CONTRIBUTING.md baseline

A fill-in template lives at `../templates/CONTRIBUTING.template.md` (next to the ruleset class JSONs).
Copy it to the repo root, fill the `<…>` placeholders from the repo's own CI + canonical agent file
(ground truth), and keep only the `[conditional]` blocks that apply:

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

1. Copy `../templates/CONTRIBUTING.template.md` → repo-root `CONTRIBUTING.md`; fill placeholders from CI + the canonical agent file.
2. Wire the import(s) into `CLAUDE.md` on the line(s) **right after its H1 title** (the H1 stays first — do NOT make an import line 1):
   - **Shape 1** (no `AGENTS.md`): add `@CONTRIBUTING.md`.
   - **Shape 2** (`AGENTS.md` exists): add `@AGENTS.md` then `@CONTRIBUTING.md`, and move whatever general instructions remain in `CLAUDE.md` into `AGENTS.md` so the wrapper stays thin.
3. Delete the now-duplicated build/test/lint block from the canonical agent file — **only** that block (keep run/serve/deploy/ops commands; see the over-trim rule above).
4. Add a `## Contributing` link to `README.md`; remove any doc→`CLAUDE.md` pointers.
5. Branch `docs/add-contributing`, Conventional + signed commit, open a PR; never merge.
