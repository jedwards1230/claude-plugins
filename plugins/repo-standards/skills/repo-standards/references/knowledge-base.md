# Knowledge base — the agent map + the docs/ minimum

`repo-docs.md` owns the root docs' *split* (who owns what prose). This standard owns what sits
underneath: how the **canonical agent file** routes into the repo's knowledge base, and the minimum
`docs/` a standard-tier repo carries. Lightweight-tier repos are exempt (same litmus as the docs
split).

Throughout this file, "the map" means that canonical agent file — **`AGENTS.md` when the repo has
one, otherwise `CLAUDE.md`** (`repo-docs.md` defines the two shapes). In Shape 2 the map is
`AGENTS.md` and `CLAUDE.md` is a thin wrapper that imports it; every rule below then applies to
`AGENTS.md`.

The goal is agent-operability: an agent's working context is scarce, so the map must be a small,
stable entry point that *routes* to depth, loaded lazily — never a manual that front-loads everything.

## The map is a map, not a manual

- **Line budget: ~100 lines.** Over ~150 is an audit finding. A map that keeps growing is absorbing
  content that belongs in a `docs/` file or a package doc — route to it instead. (Shape 2: the budget
  is the map's — `AGENTS.md`; the `CLAUDE.md` wrapper is ~4 lines and doesn't count against it.)
- **Hybrid loading — eager imports plus a lazy index.** Two tiers, chosen deliberately:
  - **Eager (`@import`)**: `@CONTRIBUTING.md` always (placement rule in `repo-docs.md`), plus **at
    most one** repo-specific doc that pays for its tokens on nearly every task — e.g. a fork-policy
    doc in a fork, a QA/verification catalog in a UI repo. Two eager imports is the ceiling; wanting
    a third means one of them belongs in the index. **All imports live in `CLAUDE.md`** — in Shape 2
    that's `@AGENTS.md` (the map itself, which doesn't count against the ceiling) plus
    `@CONTRIBUTING.md` plus at most that one extra; `AGENTS.md` itself never imports.
  - **Lazy (the map index)**: everything else is a routing line — *"Full requirements:
    `docs/PRD.md`. Read it before structural changes."* — loaded only when the task needs it.
- **Every file under `docs/` must be reachable from the map.** An unrouted doc is invisible to an
  agent that starts from the map — it will re-derive (or contradict) what the doc already says.
  One routing line per doc, or one line for a directory of same-shaped docs ("design history in
  `docs/design/`").
- **What the map body owns**: a one-paragraph purpose, the invariants block (below), the authority
  boundary (below, infra repos), the routing index, and codebase-unique run/ops commands (per
  `repo-docs.md`). **What it must not absorb**: package-by-package detail tables that restate
  package docs, env-var references, schema listings, TODO lists — each of those is a `docs/` file or
  package doc the map routes to.

Template: `../templates/CLAUDE.template.md` — a filled-shape skeleton of the above (in Shape 2, copy
that body into `AGENTS.md` per the note at its top).

## Minimum docs/ (standard tier)

| Doc | Job |
|---|---|
| `docs/PRD.md` **or** `docs/CONTRACT.md` | requirements source of truth (pick one — see below) |
| `docs/TESTING.md` | how to *prove* a change: test layers → what CI runs when, the bootable/demo path, an "explicitly avoid" anti-pattern list |
| `docs/design/` *(optional)* | dated design docs / ADRs for decisions too big for a PR description |

- **PRD vs CONTRACT — pick one, not both.** A **PRD** when requirements are outcome-shaped: users,
  jobs, scenarios, non-goals — the doc answers *"what should this do and for whom."* A **CONTRACT**
  when the repo's primary consumers are programs or other repos and requirements are
  interface-shaped: env vars, schemas, wire formats, exit codes, column names — numbered sections
  (`§2.14`) so code review and other docs can cite clauses precisely. If a repo genuinely needs
  both, the CONTRACT is the source of truth and the PRD cites it — never two parallel authorities.
- **The requirements source of truth lives in the repo it governs.** Never in an umbrella or
  sibling repo: an agent that clones only this repo must be able to reach its own requirements. An
  umbrella repo may hold a *copy or summary* that links here — not the original.
- **Small-repo escape hatch**: a repo whose CONTRIBUTING testing section already fully covers
  verification may skip `docs/TESTING.md` until it outgrows that; a thin adapter whose "product"
  is one README paragraph may skip the PRD. The escape hatch is for genuinely small repos — not
  for deferring the write-up in a repo that already has nontrivial behavior to specify.

## Invariants (a named section in the map)

A short numbered list — **"violations are bugs"** — of properties that must never regress, distinct
from style/conventions: breaking one is a defect even if every test passes.

- Each entry is **checkable in review**: phrased so a reviewer (human or agent) can look at a diff
  and answer "does this break it — yes/no." Not aspirations ("keep it simple"), not style.
- Typical sources: architectural layering ("app consumes the SDK only through the typed contract"),
  security properties ("no bare `kind: Secret` manifests"; "three-layer allowlist stays intact"),
  data-safety ("journals are never deleted, only archived"), compatibility ("wire format changes
  require a CONTRACT § update first").
- Keep it to **≤ 7 entries**. Ten invariants is a policy doc the map should route to; the section
  holds only the ones worth paying context for on every task.

## Authority boundary (repos that operate real systems)

Infra-class repos (IaC, config management, GitOps manifests) add a named section to the map — a
table, not prose — declaring who may perform each class of operation, through what mechanism, and
why:

| Operation | Performed by | Mechanism | Why / escalation |
|---|---|---|---|
| *(example)* plan / diff | agent, freely | read-only credentials or CI plan job | safe read |
| *(example)* apply to prod | CI only, human-approved | environment gate + required reviewer | blast radius |
| *(example)* edit secret store | human only | no credentials in CI or agent context | chicken-and-egg |

Three enforcement archetypes cover the common cases — name which one each pipeline follows:

1. **Gated pipeline** (e.g. Terraform/OpenTofu): writes flow through CI — PR plan is free, apply
   runs only in a protected environment behind a required reviewer, with plan and apply using
   separately-scoped credentials. The agent's write authority ends at "open a PR."
2. **Scheduled drift report** (e.g. Ansible): CI's *standing* behavior never writes to hosts — it
   runs check-mode on a schedule and publishes the diff; humans run the applying playbooks, and the
   agent reads the standing drift report instead of probing live systems. If a dispatch-only apply
   lane exists, it is not an exception to declare away — it is its own row in the table (who may
   dispatch it, behind what gate), because "anyone with repo write access via the Actions UI" is a
   very different boundary than "human at a terminal with the vault key."
3. **GitOps reconciler** (e.g. Argo CD): merging to the default branch *is* the write; the
   reconciler applies it. Declare per-path sync policy (auto-sync vs manual-sync) so the agent
   knows when a merge is the whole job and when a human must still trigger sync.

Every declared boundary must name a **real enforcing mechanism** (a workflow file, an environment
gate, a credential scope) — a boundary enforced only by prose, or only by an AI PR reviewer that
can be skipped, is a documented wish, not a boundary; the audit flags those. Two mechanisms that
deserve explicit attention:

- **"Merged once CI is green" is only true if the `main` ruleset lists `required_status_checks`**
  (the skill's status-checks overlay). A PR-required ruleset with zero required checks and zero
  required approvals gates on nothing but thread resolution — and if `bypass_actors` grants an
  admin `always` bypass, say so in the table rather than letting CONTRIBUTING imply a gate that
  is not there.
- **A repo-local `.claude/settings.json` permission allowlist is a real mechanism** for the
  agent-direct column: allow the plan/read/lint verbs, omit the apply/sync/push verbs, and every
  write becomes an explicit human approval instead of a silent capability. Cheap, versioned with
  the repo, and it enforces exactly what the table claims.

## Hub and spoke: component detail

Component-level depth lives **with the component**, routed from the map — never inlined into it:

- **Go**: a `doc.go` package comment per nontrivial package (renders on pkg.go.dev, greppable,
  adjacent to the code). **Other stacks**: a `README.md` per role/module/package directory.
- The map's Layout section carries **one line per component** plus "see its package doc" — the line
  says what it *is*; the spoke doc says how it works.
- **Spoke docs update in the same PR as the component they describe.** State this rule in
  CONTRIBUTING's documentation section. It is what keeps the map from re-absorbing detail ("the
  package doc is stale so I'll explain it in the map") and what keeps spokes trustworthy.
