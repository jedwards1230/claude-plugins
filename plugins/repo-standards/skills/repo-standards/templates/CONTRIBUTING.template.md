<!--
CONTRIBUTING.md baseline — repo-standards plugin.

HOW TO USE
- Copy this to the repo root as CONTRIBUTING.md and fill every <ANGLE-BRACKET>
  placeholder from the repo's OWN CLAUDE.md + CI workflows (ground truth — never
  invent commands; copy them verbatim so they match CI exactly).
- Keep a [conditional: ...] block only when its condition holds; delete it otherwise.
- Pick exactly one Release variant and delete the others.
- Delete this comment block before committing.

RULES (see SKILL.md "Documentation files — README / CONTRIBUTING / CLAUDE.md")
- This file is the SINGLE canonical home for build/test/lint + the PR/release process.
- It states ONE set of rules for all contributors (human or agent). No "for AI agents"
  section, and no distinction between humans and agents anywhere.
- It NEVER references CLAUDE.md. (CLAUDE.md @imports this file, not the reverse.)
- CLAUDE.md must NOT duplicate the build/test/lint block — delete it there. CLAUDE.md's
  `@CONTRIBUTING.md` line goes immediately after its H1 title (H1 stays first, NOT the
  import) and is the single reference between the two files.
- README links here with a short `## Contributing` section.
-->

# Contributing to <REPO>

<1–2 sentence description of what the repo is; all changes go through the workflow below.>

## Prerequisites

<Toolchain + versions.>
<!-- [conditional: repo has a .devcontainer/] -->
The repository ships a devcontainer (`.devcontainer/`) with the full toolchain preinstalled — opening the repo in it is the quickest way to get a working environment.

## Build, test & lint

```bash
<canonical build / test / lint / format commands, copied verbatim from CI so they match exactly>
```

## Documentation

Keep documentation current as part of the change, not as a follow-up — update the README and any affected docs in the same PR.
<!-- Optional: repo-specific update triggers, e.g. "a new env var → `docs/configuration.md`; a new endpoint → `docs/api.md`." -->

## Before you open a PR

- Make sure all CI checks pass locally first — run the formatter, linter, and tests.
<!-- [conditional: repo has .pre-commit-config.yaml] -->
- Run `pre-commit run --all-files` (this repo uses pre-commit hooks).
<!-- [conditional: a blocking Stop hook gates commits locally] -->
- A local commit gate runs <checks, e.g. `go vet` + golangci-lint> and will block until they pass — fix any findings before committing.

## Branching & commits

- Branch off `main`; never commit directly to `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, …).
- Sign your commits where possible (`git commit -S`).
- Keep each PR focused; delete dead code rather than commenting it out.

## Pull requests

- Open the PR against `main`.
- Every PR runs CI. Resolve **all** review threads before the PR is merged.
<!-- [conditional: repo runs an automated PR review (e.g. a Claude review workflow) on pull requests] -->
- An automated code review runs on each PR; address and resolve its threads like any other review.
- A PR can be merged once CI is green and all review threads are resolved.

## Releases

<!-- Pick ONE variant; delete the other two. See SKILL.md for which class fits the repo. -->

<!-- [variant A — opt-in semver label (standard for versioned artifacts)] -->
Releases are opt-in. Before merging, add one of `semver:patch`, `semver:minor`, or `semver:major` to the PR to cut a release on merge; with no label, merging does not release. A release publishes a single immutable `vX.Y.Z` tag with auto-generated release notes.

<!-- [variant B — no versioned release (continuous deploy / GitOps / ops repo)] -->
This repo is not a versioned artifact — there is no release step. Merging to `main` <deploys automatically via X / is applied via GitOps / builds the image>.

<!-- [variant C — bespoke] -->
<Describe the actual release mechanism in 1–2 sentences; link the release workflow file.>
