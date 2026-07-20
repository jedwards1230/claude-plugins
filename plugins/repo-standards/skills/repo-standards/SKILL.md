---
name: repo-standards
description: Preferred GitHub repository standards — repo settings baseline (wiki/projects off, auto-delete merged branches, SHA-pinned actions, Dependabot security updates), branch-ruleset classes, Dependabot version-updates config, the README/CONTRIBUTING/CLAUDE.md doc split, and a lightweight tier for content/asset/config repos, all audited/applied with `gh`. Use when asked to "standardize a repo", "set up branch protection", "apply repo rulesets", "audit repo settings", "protect main", "turn off the wiki/projects", "enable Dependabot", "add a dependabot.yml", "set up dependency updates", "add a CONTRIBUTING", "classify a repo as lightweight", or to classify a repo as public/private-infra/scratch.
---

# repo-standards

Preferred conventions for a GitHub repo portfolio, applied with `gh`. These are opinionated
defaults — sane starting points, not laws; adjust the policy choices (which settings, which
ruleset shape, which labels) to taste. Two layers:

1. **Repo settings baseline** — applies to *every* repo (wiki/projects off, auto-delete merged
   branches, suggest-update-branch, hardened Actions).
2. **Branch rulesets** — one `main` ruleset per repo, drawn from one of three classes that
   differ on whether a PR is required and who gets a break-glass bypass.

> **No inventory here.** This skill describes the *standard* and runs against any repo you point
> it at; which repo is which class is a consumer concern — track that in your own inventory (a
> doc, a spreadsheet, wherever), not in this skill.

All snippets use `gh api` (REST — rulesets have no GraphQL mutation). Set `OWNER` to your GitHub
org/user. Quote URLs so `?`/`~` don't shell-glob.

## Tier — Full vs Lightweight

Before applying the rest of this standard, classify the repo. **Full tier** (default) is any
normal software repo — everything below applies. **Lightweight tier** is a repo with no
application code, no CI workflows, and no dependency manifests: personal config repos (Neovim,
ESPHome), a GitHub profile README, or an asset/reference store (CAD/STEP files). Litmus: **is
there anything to build, test, or version?** No → lightweight.

| Still applies | Waived |
|---|---|
| Layer-1 settings baseline · Dependabot security · a Class-C-shaped `main` ruleset (block deletion + non-fast-forward, no PR) | Docs split (CONTRIBUTING.md + CLAUDE.md's `@CONTRIBUTING.md` import) · Dependabot version updates (`dependabot.yml`) · SHA-pinning (moot — applies once CI exists) |

Lightweight is not a 4th ruleset class — it pairs with the existing **Class C** shape and
additionally waives the docs split and version updates.

## Layer 1 — repo settings baseline (all repos)

| Setting | Field | Endpoint | Target |
|---------|-------|----------|:------:|
| Wiki off | `has_wiki` | `PATCH /repos/{o}/{r}` | `false` |
| Projects off | `has_projects` | `PATCH /repos/{o}/{r}` | `false` |
| Auto-delete merged branches | `delete_branch_on_merge` | `PATCH /repos/{o}/{r}` | `true` |
| Always suggest updating PR branches | `allow_update_branch` | `PATCH /repos/{o}/{r}` | `true` |
| Default `GITHUB_TOKEN` read-only | `default_workflow_permissions` | `PUT .../actions/permissions/workflow` | `read` |
| Require actions pinned to full SHA | `sha_pinning_required` | `PUT .../actions/permissions` | `true` (new repos: on by default; existing: after full-pin) |
| Dependabot alerts on | (no body) | `PUT .../vulnerability-alerts` | enabled |
| Dependabot security fixes on | (no body) | `PUT .../automated-security-fixes` | enabled |

```bash
OWNER=<your-org>; REPO=<repo>

# Repo-object baseline in one call (read current values first via the Audit loop below)
gh api -X PATCH "repos/$OWNER/$REPO" \
  -F has_wiki=false -F has_projects=false \
  -F delete_branch_on_merge=true -F allow_update_branch=true

# Default workflow token to read-only (bump per-repo where a workflow needs write)
gh api -X PUT "repos/$OWNER/$REPO/actions/permissions/workflow" \
  -F default_workflow_permissions=read

# Dependabot: security alerts + automated security fixes (empty-body PUTs).
# These are the always-on half — version updates are opt-in (see Dependabot section).
gh api -X PUT "repos/$OWNER/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$OWNER/$REPO/automated-security-fixes"
```

> **SHA-pinning is a Layer-1 default — it blocks, not warns.** Every third-party action should be
> pinned to a full commit SHA (with a `# vX.Y.Z` trailing comment): a moved or compromised tag
> (`v7`, `main`) then can't silently alter workflow behavior. `sha_pinning_required` makes *any*
> tag/branch ref (e.g. `actions/checkout@v7`) fail immediately — so *when* you enable it depends on
> whether the repo already has unpinned workflows:
>
> - **New repos: enable it up front**, as part of the Layer-1 apply. There are no existing workflows
>   to break, and any you scaffold later get pinned from day one. Just run the enforce command below
>   alongside the rest of the baseline.
> - **Existing repos: enable in two phases** — otherwise CI goes red on the next run the moment an
>   unpinned ref is evaluated:
>   1. **Pin everything first.** Resolve each `owner/action@tag` to its release commit SHA, keeping
>      the tag in a trailing comment. A pinning tool — `pinact`, `ratchet`, or `frizbee` — does this
>      accurately across a repo; hand-resolving each ref is error-prone.
>   2. **Then enforce.**
>
> Either way, the enforce call is the same. PUT replaces the policy, so resend the fields you keep:
>
> ```bash
> gh api -X PUT "repos/$OWNER/$REPO/actions/permissions" \
>   -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
> ```

## Layer 2 — branch-ruleset classes

All classes target the default branch (`~DEFAULT_BRANCH`), `enforcement: active`, and always
include `deletion` + `non_fast_forward` (block branch deletion and force-push) — which apply to
everyone *unless* a bypass actor is listed, so Class B admins can still force-push/delete `main`
when bypassing; A/C cannot.

| Class | Repos | Require PR | Resolve threads | Admin bypass | Rationale |
|-------|-------|:----------:|:---------------:|:------------:|-----------|
| **A — Public** | public, consumer-facing | ✓ | ✓ | ✗ | Others depend on these; dogfood your own PR flow — no break-glass. |
| **B — Private infra** | private, something live depends on `main` | ✓ | ✓ | ✓ `always` | Gated, but admin can break-glass for a 2am fix. |
| **C — Private scratch** | private config/toys | ✗ | – | ✗ | No PR to bypass; only guard against your own fat-finger (delete/force-push). |

`required_approving_review_count: 0` means a PR is required but a human approval is not — solo
merges still work. The B bypass is `actor_type: RepositoryRole, actor_id: 5` (built-in Admin).

JSON bodies live in `templates/` next to this file — basic examples to adapt:

| File | Class |
|------|-------|
| `class-a-public.json` | A |
| `class-b-private-infra.json` | B |
| `class-c-private-scratch.json` | C |
| `status-checks-overlay.json` | Optional CI gate |

**Optional CI gate.** The overlay ships a deliberately-invalid placeholder context
(`REPLACE_WITH_YOUR_CI_JOB_NAME`) — replace it in `status-checks-overlay.json` with the **exact**
name of a check run your CI produces (the *job* name, e.g. `Test & Lint` — not the workflow name).
A required check blocks *all* merges on any repo where no check run reports that exact context — a
footgun across uneven CI, and the reason the default is a loud sentinel rather than a plausible
`CI`: a verbatim apply fails obviously instead of silently bricking `main`. Apply per repo
(recommended for Class A repos that run CI), only after confirming the name matches a real check on
a recent PR:

```bash
# DIR = this skill's templates/ dir (the class JSONs sit next to SKILL.md);
# point it at that path — e.g. run from the skill dir with DIR=templates.
DIR=templates
jq '.rules += [input]' "$DIR/class-a-public.json" "$DIR/status-checks-overlay.json"
```

## Dependabot version updates

Dependabot is two things. **Security** updates (alerts + automated fixes) are always-on and live in
the Layer-1 baseline above — no downside, every repo. **Version** updates (the `.github/dependabot.yml`
committed file) are **opt-in per repo**: they open routine PRs, so a repo with no dependency manifests
has nothing to update and would only get noise. Add version updates when a repo has real manifests.
Lightweight-tier repos are exempt outright — no `dependabot.yml` at all.

Detect which ecosystems a repo has, then keep only those `updates:` entries:

| Ecosystem | Add an entry when the repo has |
|-----------|--------------------------------|
| `gomod` | a `go.mod` (one entry per module dir) |
| `npm` | a `package.json` (one entry per package dir) |
| `cargo` | a `Cargo.toml` |
| `pip` | `requirements*.txt` / `pyproject.toml` |
| `docker` | a `Dockerfile` |
| `github-actions` | `.github/workflows/*` — keep on ~every repo with CI |

`templates/dependabot.yml` is the starting body. A sensible convention: one PR per ecosystem via
`groups: {…: {patterns: ["*"]}}`, `open-pull-requests-limit: 5`, `labels: [dependency, chore]`, and
a `deps(<ecosystem>)` commit prefix. Copy it, delete the ecosystem blocks that don't apply, and
duplicate a block per extra subdirectory. Commit on a branch + PR; never merge directly.

## Repo docs — README / CONTRIBUTING / CLAUDE.md

Beyond settings and rulesets, a repo's three top-level docs each own a distinct, non-overlapping job:
`README.md` for users, `CONTRIBUTING.md` for contributors (build/test/lint + PR/release flow), and
`CLAUDE.md` for working *in* the code (architecture + codebase-unique run/ops commands only).
Lightweight-tier repos are exempt from this split — a README is still encouraged, but
CONTRIBUTING.md and the `@CONTRIBUTING.md` import line are not required.

**`references/repo-docs.md`** is the full standard: the ownership table, the anti-duplication rules
(CLAUDE.md `@import`s CONTRIBUTING; no doc points *at* CLAUDE.md; the build/test/lint-only over-trim
trap), the `CONTRIBUTING.md` baseline + its conditional-block table (paired with
`templates/CONTRIBUTING.template.md`), and the step-by-step apply procedure. Read it before adding or
auditing a repo's docs.

## Knowledge base — CLAUDE.md as a map + docs/

Below the three root docs sits the knowledge-base standard: `CLAUDE.md` is a **map, not a manual**
(~100-line budget; `@CONTRIBUTING.md` always eager-imported plus at most one more high-leverage
import; everything else routed lazily; every `docs/` file reachable from the map), standard-tier
repos carry a minimum `docs/` (`PRD.md` **or** `CONTRACT.md` as the in-repo requirements source of
truth, plus `TESTING.md`), CLAUDE.md carries a numbered **invariants** section ("violations are
bugs"), infra repos add an **authority-boundary** table (gated-pipeline / drift-report / GitOps
archetypes), and component depth lives in **hub-and-spoke** package docs updated in the same PR.
Lightweight-tier repos are exempt.

**`references/knowledge-base.md`** is the full standard (paired with
`templates/CLAUDE.template.md`). Read it before writing or auditing a `CLAUDE.md` or a repo's
`docs/` layout.

## Audit — what's live vs the standard

`scripts/repo-standards-audit.sh` is a portable audit helper — no monorepo assumptions, no
hardcoded owner/org, works against any repo you point it at (a `gh`-authenticated slug or a
local git clone).

**Default mode** is cheap and wide: it batches the bulk-fetchable fields (visibility,
wiki/projects, delete/update-branch, merge methods, rulesets) into one GraphQL query per
~20-repo chunk — no REST calls at all — so auditing a whole portfolio costs a handful of
GraphQL requests.

**`--deep` mode is comprehensive** — it covers the full ~83-lever settings catalog: repo
metadata/features (template/archived/discussions/pages/forking/web-signoff), PR & merge
behavior (auto-merge, squash/merge title+message enums), the complete Security & Analysis panel
(secret scanning + push protection + non-provider patterns + validity checks, Dependabot
security updates, vulnerability alerts, automated security fixes, private vulnerability
reporting), the Actions permissions surface (enabled/allowed-actions/SHA-pinning, default
workflow token permissions, fork-PR access level), per-ruleset `pull_request` rule parameters
(required review thread resolution, approving review count, allowed merge methods), immutable
releases, Pages, environments, autolinks, interaction limits, and custom properties (flagged
`n/a` on this user account — org-only).

```bash
DIR=scripts   # this skill's scripts/ dir (next to SKILL.md)

$DIR/repo-standards-audit.sh                              # current repo (from cwd)
$DIR/repo-standards-audit.sh org/repo-a org/repo-b        # explicit slugs
$DIR/repo-standards-audit.sh --file repos.txt             # one target per line
$DIR/repo-standards-audit.sh org/repo-a --deep            # full lever catalog (see above)
$DIR/repo-standards-audit.sh org/repo-a --json | jq .     # machine-readable (light shape)
$DIR/repo-standards-audit.sh org/repo-a --deep --json | jq .   # machine-readable (comprehensive nested shape)
```

Every `--deep` field degrades to `n/a` (unavailable/inapplicable — private repo without GHAS,
org-only feature on a user account, private-repo-only endpoint) or a concrete `off`/`false`
state (a real, known-absent setting, e.g. Pages never configured) on any error — one repo's
404/403/405/422 never aborts the run. Rate-limit budget: **1 GraphQL request per ~20-repo
chunk + ~13 REST requests per repo + ~1 REST request per ruleset that declares a
`pull_request` rule** (the repo object is fetched once per repo and reused for every field
that lives on it; every other REST field is one call per distinct sub-resource endpoint). Full
`--help` documents every column and the complete rate-limit design.

The `--deep` table's `RULETYPE`/`PRPARAMS` columns only summarize the *first* ruleset (extra
rulesets are counted, e.g. `DEL,NFF,PR (+1)`) — use `--deep --json` for full multi-ruleset
detail, or re-fetch a single ruleset's full body directly to compare its `rules`/`bypass_actors`
against a class template: `gh api "repos/$OWNER/$REPO/rulesets/RULESET_ID"`.

## Apply — create or update a repo's `main` ruleset

A PUT **replaces** the ruleset with exactly the body sent. Apply the class template (don't
hand-edit live); treat every ruleset write as **confirm-first** — it gates `main`.

```bash
OWNER=<your-org>; REPO=<repo>
BODY=templates/class-b-private-infra.json   # pick the class

RID=$(gh api "repos/$OWNER/$REPO/rulesets" --jq '.[] | select(.name=="main") | .id' 2>/dev/null)
if [ -n "$RID" ]; then
  gh api -X PUT  "repos/$OWNER/$REPO/rulesets/$RID" --input "$BODY"   # update in place
else
  gh api -X POST "repos/$OWNER/$REPO/rulesets"      --input "$BODY"   # create new
fi
```

Delete: `gh api -X DELETE "repos/$OWNER/$REPO/rulesets/RULESET_ID"`.

## Maintenance notes

- **Preserve other rulesets.** This governs the single `name=="main"` ruleset. Some repos carry
  a *separate* Copilot-review ruleset (or extra `copilot_code_review` rule) — match by name and
  never blanket-delete, or a naive apply loop silently drops Copilot review.
- **Visibility flip** → move the repo between classes and re-apply (a public repo shouldn't stay
  on B/C; a private one shouldn't carry A).
- **New repo** → apply the Layer-1 baseline (SHA-pinning enabled up front — no existing workflows
  to break) + the right class ruleset; record its class in your own inventory, not here.
