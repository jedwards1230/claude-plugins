# Contributing to claude-plugins

Personal Claude Code plugin marketplace. All changes go through the workflow below.

## Prerequisites

- `jq` — JSON processing (used by the version-check script)
- `python3` — JSON validation (stdlib `json.tool`)

## Build, test & lint

This repo has no compiler or test suite — CI validates JSON syntax and enforces plugin version bumps.

```bash
# Validate JSON files (marketplace.json + all plugin.json) — mirrors the JSON Validation CI job
python3 -m json.tool .claude-plugin/marketplace.json > /dev/null
find plugins -name plugin.json -print0 | xargs -0 -I{} python3 -m json.tool {} > /dev/null

# Validate plugin version bumps against main — mirrors the Plugin Version Check CI job
./scripts/check-plugin-versions.sh origin/main
```

## Documentation

Keep documentation current as part of the change, not as a follow-up — update the README and any plugin-specific docs (a plugin's own `SKILL.md` / README) in the same PR.

## Adding a plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json` (with a `version`).
2. Add the skill, hook, or agent files following the plugin structure.
3. Add an entry to `.claude-plugin/marketplace.json` (`name`, `source`, `description`) — **no `version` field**; the plugin manifest is authoritative.
4. Pushing triggers the version-validation CI.

## Before you open a PR

- Make sure all CI checks pass locally first — run the JSON validation and the version-check above.

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

There is no repo-level release — plugins are versioned independently. When you change a plugin, bump **both** version strings in the same PR (CI enforces this):

1. `version` in `plugins/<name>/.claude-plugin/plugin.json` — the only place a plugin's version lives.
2. `metadata.version` in `.claude-plugin/marketplace.json`:
   - **Major** — a plugin was added or removed
   - **Minor** — core marketplace metadata changed
   - **Patch** — a plugin's version changed
