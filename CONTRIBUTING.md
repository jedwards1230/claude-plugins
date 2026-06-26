# Contributing to claude-plugins

Personal Claude Code plugin marketplace. All changes go through the workflow below.

## Prerequisites

- `jq` — JSON processing
- `python3` — JSON validation (stdlib `json.tool`)
- `shellcheck` — shell script linting (used in CI and remote sessions)

## Build, test & lint

```bash
# Validate JSON files (marketplace.json + all plugin.json)
python3 -m json.tool .claude-plugin/marketplace.json > /dev/null
find plugins -name plugin.json -print0 | xargs -0 -I{} python3 -m json.tool {} > /dev/null

# Validate plugin version bumps against main
./scripts/check-plugin-versions.sh origin/main
```

## Documentation

Keep documentation current as part of the change, not as a follow-up — update the README and any affected docs in the same PR.

## Before you open a PR

- Make sure all CI checks pass locally first — run the formatter, linter, and tests.

## Branching & commits

- Branch off `main`; never commit directly to `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, …).
- Sign your commits where possible (`git commit -S`).
- Keep each PR focused; delete dead code rather than commenting it out.

## Pull requests

- Open the PR against `main`.
- Every PR runs CI. Resolve **all** review threads before the PR is merged.
- An automated code review runs on each PR; address and resolve its threads like any other review.
- A PR can be merged once CI is green and all review threads are resolved.

## Releases

There is no repo-level release. Each plugin is versioned independently: when you change a plugin, bump that plugin's `plugins/<name>/.claude-plugin/plugin.json` `version` **and** the marketplace `metadata.version` in `.claude-plugin/marketplace.json` in the same PR. CI enforces the version bump.
