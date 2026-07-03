#!/usr/bin/env bash
# repo-standards-audit.sh — portable audit of repo-standards conformance fields.
#
# Default mode reports, per repo: visibility, wiki/projects toggles,
# delete-branch-on-merge, allow-update-branch, allowed merge methods, and the
# main/default-branch ruleset(s). One batched GraphQL query per ~20-repo
# chunk, no REST calls — cheap enough to run over a whole portfolio.
#
# --deep expands coverage to the full lever catalog: repo metadata/features,
# PR & merge behavior, the complete Security & Analysis panel, the Actions
# permissions surface, per-ruleset pull_request rule parameters, immutable
# releases, Pages, environments, autolinks, interaction limits, and custom
# properties. See --help for the field list and rate-limit/batching design.
#
# Works against ANY GitHub repo you can `gh api` — no monorepo, no
# hardcoded owner/org, no repos.conf. Requires `gh` (authenticated) and `jq`.
set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
repo-standards-audit.sh — audit GitHub repo settings against the repo-standards baseline.

USAGE
  repo-standards-audit.sh [OPTIONS] [TARGET ...]

TARGET
  Either an "owner/repo" GitHub slug, or a local filesystem path to a git
  repo (its "origin" remote is resolved to owner/repo). Auto-detected: an
  existing directory is treated as a path, otherwise a string matching
  ^[^/]+/[^/]+$ is treated as a slug.

  With no TARGETs and nothing piped on stdin, the current repo (from cwd)
  is discovered via `gh repo view` (falling back to `git remote get-url
  origin`) and audited alone.

OPTIONS
  --file <path>   Read additional targets from a file, one per line.
                   Blank lines and lines starting with '#' are ignored.
  --deep          Fetch the full lever catalog (~83 settings): repo
                   metadata/features, PR & merge behavior, the complete
                   Security & Analysis panel, Actions permissions,
                   per-ruleset pull_request parameters, immutable releases,
                   Pages, environments, autolinks, interaction limits, and
                   custom properties. Off by default — see RATE LIMITS.
  --json          Emit a JSON array instead of the table. In --deep mode
                   this is a comprehensive nested object per repo (see
                   COLUMNS below); without --deep it's the lighter shape.
  -h, --help      Show this help.

STDIN
  If no TARGETs and no --file are given and stdin is not a tty, targets are
  read from stdin (one per line, same slug-or-path rules, '#' comments ok):

    printf 'org/repo-a\norg/repo-b\n' | repo-standards-audit.sh

EXAMPLES
  repo-standards-audit.sh                          # current repo (from cwd)
  repo-standards-audit.sh jedwards1230/scrim        # one repo by slug
  repo-standards-audit.sh org/repo-a org/repo-b ../local-clone
  repo-standards-audit.sh --file repos.txt --deep
  repo-standards-audit.sh org/repo-a --deep --json | jq .

RATE LIMITS
  Default mode: the bulk fields (visibility, wiki/projects, delete/update
  branch, merge methods, rulesets) come from ONE batched GraphQL query per
  ~20-repo chunk (aliased repository() blocks) — GraphQL has its own
  5000-point/hr budget, separate from REST, and a chunked query costs
  roughly 1 request regardless of how many repos are in it. No REST calls
  are made in default mode.

  --deep mode: one (larger) batched GraphQL query per ~20-repo chunk
  covers everything the GraphQL schema exposes (repo metadata/features,
  PR/merge enums, ruleset names + rule types), same 1-request-per-chunk
  cost. On top of that, EVERYTHING else is REST, against the repo's own
  5000/hr budget: the repo object is fetched ONCE per repo and reused for
  every field that lives on it (security_and_analysis, has_downloads,
  pull_request_creation_policy, use_squash_pr_title_as_default), plus one
  call per distinct sub-resource endpoint per repo (vulnerability-alerts,
  automated-security-fixes, private-vulnerability-reporting,
  actions/permissions, actions/permissions/workflow,
  actions/permissions/access, pages, environments, autolinks,
  interaction-limits, immutable-releases, properties/values) — 13 REST
  calls per repo total. Per-ruleset pull_request parameter detail
  (GET /rulesets/{id}) is fetched ONLY for rulesets that actually declare a
  pull_request rule, adding roughly 1 more REST call per such ruleset
  (usually 0 or 1 per repo). Every REST call degrades to 'n/a' (unavailable)
  or 'off' (a real, known-absent state) on any error — 204/403/404/405/422
  are all expected on some repos (private without GHAS, public repos where
  an endpoint is org/private-only, features never enabled) and never abort
  the run. Budget rule of thumb for --deep: 1 GraphQL request per ~20-repo
  chunk + ~13 REST requests per repo + ~1 REST request per PR-bearing
  ruleset. Keep --deep off for large batches unless you need those columns.

COLUMNS (default table)
  VIS      visibility (public/private/internal)
  WIKI     has_wiki (on = wiki enabled)
  PROJ     has_projects (on = projects enabled)
  DELBR    delete_branch_on_merge
  UPDBR    allow_update_branch
  MERGE    allowed merge methods: S/M/R = squash/merge-commit/rebase,
           uppercase = allowed, lowercase = disabled (e.g. "SmR")
  RULESET  main/default-branch ruleset(s) as "name/enforcement"; "-" if none

COLUMNS (--deep table, in addition to the above)
  FLAGS     packed single-letter feature flags, uppercase = on/true,
            lowercase = off/false: t=is_template a=archived
            d=has_discussions p=has_pages f=allow_forking
            s=web_commit_signoff_required
  AUTOMRG   allow_auto_merge
  SECSCAN   secret_scanning status
  PUSHPROT  secret_scanning_push_protection status
  NONPROV   secret_scanning_non_provider_patterns status
  VALCHK    secret_scanning_validity_checks status
  DEPSEC    dependabot_security_updates status
  VULNALRT  vulnerability_alerts_enabled (Dependabot alerts on/off)
  AUTOFIX   automated_security_fixes_enabled
  PRIVVULN  private_vulnerability_reporting_enabled
  ACTENB    Actions enabled for the repo
  ALLOWACT  actions/permissions allowed_actions (all/local_only/selected)
  SHAPIN    actions/permissions sha_pinning_required
  WFPERM    actions/permissions/workflow default_workflow_permissions
  APPRVPR   actions/permissions/workflow can_approve_pull_request_reviews
  ACCESSLV  actions/permissions/access access_level
  IMMUT     releases.immutable_releases_enabled
  RULETYPE  rule types on the first ruleset, short codes (see legend printed
            with the table); additional rulesets are summarized as a count
  PRPARAMS  pull_request rule parameters on the first ruleset: RTR = required
            review thread resolution, ARC = required approving review
            count, MRG = allowed_merge_methods (S/M/R, same convention as
            MERGE); "-" if the ruleset has no pull_request rule

  Everything not shown in the table (topics, full environment/autolink
  lists, per-ruleset bypass actors, etc.) is present in `--deep --json`.

For the full body of a ruleset (rules + bypass actors, to compare against a
class template), re-fetch it directly:
  gh api "repos/<owner>/<repo>/rulesets/<id>"
EOF
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "$SCRIPT_NAME: required command '$1' not found in PATH" >&2
    exit 1
  }
}
require_cmd gh
require_cmd jq
require_cmd git

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
FILE_OPT=""
DEEP=0
JSON_OUT=0
POSITIONAL=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --file)
      [ "$#" -ge 2 ] || { echo "$SCRIPT_NAME: --file requires an argument" >&2; exit 2; }
      FILE_OPT="$2"
      shift 2
      ;;
    --file=*)
      FILE_OPT="${1#--file=}"
      shift
      ;;
    --deep)
      DEEP=1
      shift
      ;;
    --json)
      JSON_OUT=1
      shift
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        POSITIONAL+=("$1")
        shift
      done
      ;;
    -*)
      echo "$SCRIPT_NAME: unknown option '$1' (see --help)" >&2
      exit 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Trim leading/trailing whitespace without spawning a subprocess.
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Parse an owner/repo slug out of a git remote URL. Handles:
#   git@host:owner/repo.git
#   https://host/owner/repo(.git)
#   ssh://git@host/owner/repo(.git)
parse_owner_repo_from_url() {
  local url="$1"
  url="${url%.git}"
  if [[ "$url" =~ ^git@[^:]+:(.+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$url" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+/(.+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  echo "$SCRIPT_NAME: cannot parse owner/repo from remote URL: $url" >&2
  return 1
}

# Resolve one raw target (slug or local path) to an owner/repo slug.
resolve_target() {
  local raw="$1" url slug
  if [ -d "$raw" ]; then
    url="$(git -C "$raw" remote get-url origin 2>/dev/null)" || {
      echo "$SCRIPT_NAME: '$raw' has no 'origin' remote" >&2
      return 1
    }
    slug="$(parse_owner_repo_from_url "$url")" || return 1
    printf '%s\n' "$slug"
    return 0
  fi
  if [[ "$raw" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  echo "$SCRIPT_NAME: cannot resolve '$raw' (not an existing directory and not an owner/repo slug)" >&2
  return 1
}

# Discover the current repo from cwd: `gh repo view` first, then the origin remote.
discover_current_repo() {
  local slug
  slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || slug=""
  if [ -n "$slug" ]; then
    printf '%s\n' "$slug"
    return 0
  fi
  local url
  url="$(git remote get-url origin 2>/dev/null)" || {
    echo "$SCRIPT_NAME: no TARGET given, 'gh repo view' failed, and cwd has no 'origin' remote." >&2
    echo "$SCRIPT_NAME: pass a repo explicitly (owner/repo or a local path) — see --help." >&2
    return 1
  }
  parse_owner_repo_from_url "$url"
}

# ---------------------------------------------------------------------------
# Gather raw targets: positional args, --file, stdin, or cwd-discovery
# ---------------------------------------------------------------------------
RAW=()
HAVE_EXPLICIT_INPUT=0

if [ "${#POSITIONAL[@]}" -gt 0 ]; then
  RAW+=("${POSITIONAL[@]}")
  HAVE_EXPLICIT_INPUT=1
fi

if [ -n "$FILE_OPT" ]; then
  [ -r "$FILE_OPT" ] || { echo "$SCRIPT_NAME: cannot read --file '$FILE_OPT'" >&2; exit 2; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    RAW+=("$line")
  done < "$FILE_OPT"
  HAVE_EXPLICIT_INPUT=1
fi

if [ "$HAVE_EXPLICIT_INPUT" -eq 0 ] && [ ! -t 0 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    RAW+=("$line")
  done
fi

if [ "${#RAW[@]}" -eq 0 ]; then
  slug="$(discover_current_repo)" || exit 1
  RAW+=("$slug")
fi

# ---------------------------------------------------------------------------
# Resolve + dedupe targets
#
# Dedup compares full resolved slugs directly (a linear membership scan — no
# home-rolled delimiter to collide with, and no bash-4 associative array, so
# this still runs on the stock macOS bash 3.2). Target counts are small
# (dozens of repos at most), so the O(n²) scan is irrelevant. FAILED collects
# raw targets that didn't resolve so we can name them before bailing, instead
# of a bare "no resolvable repos" with no clue which inputs were bad.
# ---------------------------------------------------------------------------
RESOLVED=()
FAILED=()
for raw in "${RAW[@]}"; do
  if ! slug="$(resolve_target "$raw")"; then
    FAILED+=("$raw")
    continue
  fi
  dup=0
  for seen in ${RESOLVED[@]+"${RESOLVED[@]}"}; do
    [ "$seen" = "$slug" ] && { dup=1; break; }
  done
  [ "$dup" -eq 1 ] && continue
  RESOLVED+=("$slug")
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "$SCRIPT_NAME: could not resolve ${#FAILED[@]} target(s): ${FAILED[*]}" >&2
fi

if [ "${#RESOLVED[@]}" -eq 0 ]; then
  echo "$SCRIPT_NAME: no resolvable repos to audit" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# GraphQL: batch the bulk-fetchable fields, ~20 repos per request.
#
# Two field sets: GQL_FIELDS_LIGHT (default mode, unchanged from the
# original cheap query) and GQL_FIELDS_DEEP (superset — repo metadata,
# feature flags, PR/merge enums, and per-ruleset rule types + a databaseId
# so --deep can fetch per-ruleset pull_request parameters via REST). Both
# cost ~1 GraphQL request per chunk regardless of field count.
# ---------------------------------------------------------------------------
CHUNK_SIZE=20

GQL_FIELDS_LIGHT='nameWithOwner visibility hasWikiEnabled hasProjectsEnabled deleteBranchOnMerge allowUpdateBranch mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed rulesets(first: 10) { nodes { name enforcement } }'

GQL_FIELDS_DEEP='nameWithOwner visibility defaultBranchRef { name } isTemplate isArchived isFork isMirror isEmpty isLocked isDisabled description homepageUrl repositoryTopics(first: 20) { nodes { topic { name } } } hasIssuesEnabled hasWikiEnabled hasProjectsEnabled hasDiscussionsEnabled forkingAllowed webCommitSignoffRequired licenseInfo { spdxId } isSecurityPolicyEnabled createdAt pushedAt deleteBranchOnMerge allowUpdateBranch mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed squashMergeCommitTitle squashMergeCommitMessage mergeCommitTitle mergeCommitMessage hasVulnerabilityAlertsEnabled rulesets(first: 20) { nodes { databaseId name target enforcement rules(first: 20) { nodes { type } } } }'

# fetch_graphql_chunk <fields> <slug> [<slug> ...] — one batched query for the whole chunk.
fetch_graphql_chunk() {
  local fields="$1"
  shift
  local -a chunk=("$@")
  local decl="" aliases="" i owner repo
  local -a gh_args=()
  for i in "${!chunk[@]}"; do
    # Belt-and-suspenders: slugs already came through resolve_target, but
    # guard the owner/repo split anyway. A malformed entry is skipped (no
    # alias emitted) rather than aborting the batch — its r${i} is then
    # absent from the response, so the main loop renders it as an ERROR row,
    # consistent with the script's graceful-degradation contract.
    if [[ ! "${chunk[$i]}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
      echo "$SCRIPT_NAME: skipping malformed slug '${chunk[$i]}' in GraphQL batch" >&2
      continue
    fi
    owner="${chunk[$i]%%/*}"
    repo="${chunk[$i]#*/}"
    decl="${decl}\$owner${i}: String!, \$name${i}: String!, "
    aliases="${aliases}r${i}: repository(owner: \$owner${i}, name: \$name${i}) { ${fields} } "
    gh_args+=(-f "owner${i}=${owner}" -f "name${i}=${repo}")
  done
  decl="${decl%, }"
  gh api graphql -f "query=query(${decl}) { ${aliases} }" "${gh_args[@]}"
}

# Normalize one GraphQL repository object (or null) into the light result schema.
normalize_repo_json() {
  local node="$1" slug="$2"
  if [ "$node" = "null" ]; then
    jq -n --arg repo "$slug" '{repo: $repo, error: true}'
    return 0
  fi
  printf '%s' "$node" | jq -c '{
    repo: .nameWithOwner,
    error: false,
    visibility: (.visibility // "n/a" | ascii_downcase),
    has_wiki: .hasWikiEnabled,
    has_projects: .hasProjectsEnabled,
    delete_branch_on_merge: .deleteBranchOnMerge,
    allow_update_branch: .allowUpdateBranch,
    merge_commit_allowed: .mergeCommitAllowed,
    squash_merge_allowed: .squashMergeAllowed,
    rebase_merge_allowed: .rebaseMergeAllowed,
    ruleset: ([.rulesets.nodes[] | "\(.name)/\(.enforcement)"] | join(", "))
  }'
}

# Normalize one GraphQL repository object (or null) into the deep base schema
# (pre-REST-enrichment). REST fields are merged on top in fetch_deep_rest.
normalize_repo_json_deep() {
  local node="$1" slug="$2"
  if [ "$node" = "null" ]; then
    jq -n --arg repo "$slug" '{repo: $repo, error: true}'
    return 0
  fi
  printf '%s' "$node" | jq -c '{
    repo: .nameWithOwner,
    error: false,
    visibility: (.visibility // "n/a" | ascii_downcase),
    default_branch: (.defaultBranchRef.name // null),
    is_template: .isTemplate,
    archived: .isArchived,
    is_fork: .isFork,
    is_mirror: .isMirror,
    is_empty: .isEmpty,
    is_locked: .isLocked,
    is_disabled: .isDisabled,
    description: .description,
    homepage: .homepageUrl,
    topics: [.repositoryTopics.nodes[]?.topic.name],
    has_issues: .hasIssuesEnabled,
    has_wiki: .hasWikiEnabled,
    has_projects: .hasProjectsEnabled,
    has_discussions: .hasDiscussionsEnabled,
    allow_forking: .forkingAllowed,
    web_commit_signoff_required: .webCommitSignoffRequired,
    license_spdx_id: (.licenseInfo.spdxId // null),
    is_security_policy_enabled: .isSecurityPolicyEnabled,
    created_at: .createdAt,
    pushed_at: .pushedAt,
    pull_requests: {
      allow_squash_merge: .squashMergeAllowed,
      allow_merge_commit: .mergeCommitAllowed,
      allow_rebase_merge: .rebaseMergeAllowed,
      allow_auto_merge: .autoMergeAllowed,
      delete_branch_on_merge: .deleteBranchOnMerge,
      allow_update_branch: .allowUpdateBranch,
      squash_merge_commit_title: .squashMergeCommitTitle,
      squash_merge_commit_message: .squashMergeCommitMessage,
      merge_commit_title: .mergeCommitTitle,
      merge_commit_message: .mergeCommitMessage
    },
    security_and_analysis: {
      has_vulnerability_alerts_enabled_graphql: .hasVulnerabilityAlertsEnabled
    },
    rulesets: [.rulesets.nodes[] | {
      id: .databaseId,
      name: .name,
      target: .target,
      enforcement: .enforcement,
      rule_types: [.rules.nodes[]?.type]
    }]
  }'
}

# ---------------------------------------------------------------------------
# --deep REST enrichment
#
# Every call below degrades to a documented default (never aborts the run)
# on any non-2xx response: "n/a" for genuinely unavailable/inapplicable
# fields (private repo without GHAS, org-only feature on a user account,
# private-repo-only 405s, etc.), or a concrete "off" state for fields where
# absence IS the answer (Pages never configured, no vulnerability alerts).
# ---------------------------------------------------------------------------

# rest_json_or_null <path> — raw JSON body on success, the JSON literal
# `null` on any failure (404/403/405/422/...). Distinguishes "no data" from
# "legitimately empty" (e.g. interaction-limits returns `{}` on success).
rest_json_or_null() {
  local path="$1" out
  if out="$(gh api "$path" 2>/dev/null)" && [ -n "$out" ]; then
    printf '%s' "$out"
  else
    printf 'null'
  fi
}

# rest_exists_bool <path> — "true" if the call succeeds (2xx, incl. 204 with
# no body), "false" otherwise. Used for vulnerability-alerts, whose presence
# (not its body) is the signal.
rest_exists_bool() {
  local path="$1"
  if gh api "$path" >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

# fetch_deep_rest <slug> — one merged JSON fragment covering every --deep
# REST-sourced field. 13 REST calls: the repo object once, plus one call
# per distinct sub-resource endpoint.
fetch_deep_rest() {
  local slug="$1"
  local repo_json vuln_alerts autofix_json privvuln_json
  local perms_json permswf_json permsaccess_json
  local pages_json env_json autolinks_json interaction_json immutable_json props_json

  repo_json="$(rest_json_or_null "repos/${slug}")"
  vuln_alerts="$(rest_exists_bool "repos/${slug}/vulnerability-alerts")"
  autofix_json="$(rest_json_or_null "repos/${slug}/automated-security-fixes")"
  privvuln_json="$(rest_json_or_null "repos/${slug}/private-vulnerability-reporting")"
  perms_json="$(rest_json_or_null "repos/${slug}/actions/permissions")"
  permswf_json="$(rest_json_or_null "repos/${slug}/actions/permissions/workflow")"
  permsaccess_json="$(rest_json_or_null "repos/${slug}/actions/permissions/access")"
  pages_json="$(rest_json_or_null "repos/${slug}/pages")"
  env_json="$(rest_json_or_null "repos/${slug}/environments")"
  autolinks_json="$(rest_json_or_null "repos/${slug}/autolinks")"
  interaction_json="$(rest_json_or_null "repos/${slug}/interaction-limits")"
  immutable_json="$(rest_json_or_null "repos/${slug}/immutable-releases")"
  props_json="$(rest_json_or_null "repos/${slug}/properties/values")"

  jq -n \
    --argjson repo "$repo_json" \
    --argjson vuln_alerts "$vuln_alerts" \
    --argjson autofix "$autofix_json" \
    --argjson privvuln "$privvuln_json" \
    --argjson perms "$perms_json" \
    --argjson permswf "$permswf_json" \
    --argjson permsaccess "$permsaccess_json" \
    --argjson pages "$pages_json" \
    --argjson env "$env_json" \
    --argjson autolinks "$autolinks_json" \
    --argjson interaction "$interaction_json" \
    --argjson immutable "$immutable_json" \
    --argjson props "$props_json" \
    '
    # `//` treats `false` (not just null) as falsy, so a field that is
    # legitimately `false` would silently collapse to the fallback. `nz`
    # substitutes the fallback ONLY on an actual null/missing field.
    def nz(v; fallback): if v == null then fallback else v end;
    ($repo // {}) as $r |
    {
      has_downloads: nz($r.has_downloads; "n/a"),
      pull_request_creation_policy: nz($r.pull_request_creation_policy; "n/a"),
      pull_requests: {
        use_squash_pr_title_as_default: nz($r.use_squash_pr_title_as_default; "n/a")
      },
      security_and_analysis: {
        advanced_security: nz($r.security_and_analysis.advanced_security.status; "n/a"),
        secret_scanning: nz($r.security_and_analysis.secret_scanning.status; "n/a"),
        secret_scanning_push_protection: nz($r.security_and_analysis.secret_scanning_push_protection.status; "n/a"),
        secret_scanning_non_provider_patterns: nz($r.security_and_analysis.secret_scanning_non_provider_patterns.status; "n/a"),
        secret_scanning_validity_checks: nz($r.security_and_analysis.secret_scanning_validity_checks.status; "n/a"),
        dependabot_security_updates: nz($r.security_and_analysis.dependabot_security_updates.status; "n/a"),
        vulnerability_alerts_enabled: $vuln_alerts,
        automated_security_fixes_enabled: nz($autofix.enabled; "n/a"),
        automated_security_fixes_paused: nz($autofix.paused; "n/a"),
        private_vulnerability_reporting_enabled: (if $privvuln == null then "n/a" else nz($privvuln.enabled; "n/a") end)
      },
      actions: {
        enabled: nz($perms.enabled; "n/a"),
        allowed_actions: nz($perms.allowed_actions; "n/a"),
        sha_pinning_required: nz($perms.sha_pinning_required; "n/a"),
        default_workflow_permissions: nz($permswf.default_workflow_permissions; "n/a"),
        can_approve_pull_request_reviews: nz($permswf.can_approve_pull_request_reviews; "n/a"),
        access_level: nz($permsaccess.access_level; "n/a")
      },
      releases: {
        immutable_releases_enabled: nz($immutable.enabled; false),
        immutable_releases_enforced_by_owner: nz($immutable.enforced_by_owner; false)
      },
      pages: (
        if $pages == null then
          {enabled: false, build_type: null, source_branch: null, source_path: null, https_enforced: null, cname: null, public: null}
        else
          {
            enabled: true,
            build_type: nz($pages.build_type; null),
            source_branch: nz($pages.source.branch; null),
            source_path: nz($pages.source.path; null),
            https_enforced: nz($pages.https_enforced; null),
            cname: nz($pages.cname; null),
            public: nz($pages.public; null)
          }
        end
      ),
      custom_properties: (if $props == null then "n/a" else $props end),
      autolinks: ($autolinks // []),
      environments: [
        (($env.environments // [])[]) | {
          name: .name,
          protection_rules_count: ((.protection_rules // []) | length),
          deployment_branch_policy: .deployment_branch_policy,
          can_admins_bypass: .can_admins_bypass
        }
      ],
      interaction_limits: (if $interaction == null then "n/a" else $interaction end)
    }
    '
}

# enrich_rulesets_with_pr_params <slug> <rulesets_json_array>
# For each ruleset that declares a PULL_REQUEST rule, fetch its per-ruleset
# REST detail and attach the pull_request rule's parameters. One REST call
# per PR-bearing ruleset (usually 0 or 1 per repo) — never per-repo blanket.
enrich_rulesets_with_pr_params() {
  local slug="$1" rulesets_json="$2"
  local count i out="[]"
  count="$(printf '%s' "$rulesets_json" | jq 'length')"
  i=0
  while [ "$i" -lt "$count" ]; do
    local rs id has_pr params
    rs="$(printf '%s' "$rulesets_json" | jq -c ".[$i]")"
    id="$(printf '%s' "$rs" | jq -r '.id // empty')"
    has_pr="$(printf '%s' "$rs" | jq -r '(.rule_types // []) | index("PULL_REQUEST") != null')"
    if [ "$has_pr" = "true" ] && [ -n "$id" ]; then
      params="$(gh api "repos/${slug}/rulesets/${id}" 2>/dev/null | jq -c '([.rules[]? | select(.type=="pull_request") | .parameters][0]) // {}')" || params='{}'
      [ -n "$params" ] || params='{}'
      rs="$(printf '%s' "$rs" | jq -c --argjson p "$params" '. + {pull_request_parameters: $p}')"
    fi
    out="$(printf '%s' "$out" | jq -c --argjson r "$rs" '. + [$r]')"
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Main fetch loop
# ---------------------------------------------------------------------------
ALL_JSON=()
TOTAL="${#RESOLVED[@]}"
OFFSET=0
GQL_ERR_FILE="$(mktemp)" || { echo "$SCRIPT_NAME: mktemp failed" >&2; exit 1; }
trap 'rm -f "$GQL_ERR_FILE"' EXIT

GQL_FIELDS="$GQL_FIELDS_LIGHT"
[ "$DEEP" -eq 1 ] && GQL_FIELDS="$GQL_FIELDS_DEEP"

while [ "$OFFSET" -lt "$TOTAL" ]; do
  CHUNK=("${RESOLVED[@]:OFFSET:CHUNK_SIZE}")

  # `gh api graphql` exits non-zero whenever ANY aliased repository() in the
  # chunk hits a partial error (e.g. NOT_FOUND for one bad slug) — even
  # though the JSON body still carries usable data for the rest. Capture
  # stdout regardless of exit code; only treat it as fatal if `.data` itself
  # is missing (auth failure, malformed query, etc.), not a per-repo miss.
  RESPONSE="$(fetch_graphql_chunk "$GQL_FIELDS" "${CHUNK[@]}" 2>"$GQL_ERR_FILE")" || true
  if ! printf '%s' "$RESPONSE" | jq -e 'has("data") and (.data != null)' >/dev/null 2>&1; then
    echo "$SCRIPT_NAME: GraphQL request failed for chunk starting at '${CHUNK[0]}':" >&2
    cat "$GQL_ERR_FILE" >&2
    exit 1
  fi

  for i in "${!CHUNK[@]}"; do
    slug="${CHUNK[$i]}"
    node="$(printf '%s' "$RESPONSE" | jq -c ".data.r${i}")"

    if [ "$DEEP" -eq 1 ]; then
      obj="$(normalize_repo_json_deep "$node" "$slug")"
      # jq -e sets exit status from the value of .error itself (true → 0,
      # false → 1), so "not an error repo → enrich" reads directly off the
      # boolean without stringifying and string-comparing it.
      if ! printf '%s' "$obj" | jq -e '.error' >/dev/null 2>&1; then
        deep_rest="$(fetch_deep_rest "$slug")"
        obj="$(jq -c -n --argjson a "$obj" --argjson b "$deep_rest" '$a * $b')"
        rulesets_enriched="$(enrich_rulesets_with_pr_params "$slug" "$(printf '%s' "$obj" | jq -c '.rulesets')")"
        obj="$(printf '%s' "$obj" | jq -c --argjson rs "$rulesets_enriched" '.rulesets = $rs | .has_pages = .pages.enabled')"
      fi
    else
      # Non-deep never fetches these three REST-only fields; they're always
      # null here (both for good repos and error rows), so set them
      # unconditionally.
      obj="$(normalize_repo_json "$node" "$slug")"
      obj="$(printf '%s' "$obj" | jq -c '. + {
        secret_scanning: null, secret_scanning_push_protection: null, dependabot_security_updates: null
      }')"
    fi
    ALL_JSON+=("$obj")
  done

  OFFSET=$((OFFSET + CHUNK_SIZE))
done

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [ "$JSON_OUT" -eq 1 ]; then
  printf '%s\n' "${ALL_JSON[@]}" | jq -s '.'
  exit 0
fi

TABLE_FILTER_LIGHT='
def b: if . == true then "on" elif . == false then "off" else "-" end;
def d: if . == null then "-" else . end;
if .error then
  [.repo, "ERROR", "-", "-", "-", "-", "-", "not found or no access"] | @tsv
else
  [
    .repo,
    (.visibility // "-"),
    (.has_wiki | b),
    (.has_projects | b),
    (.delete_branch_on_merge | b),
    (.allow_update_branch | b),
    ((if .squash_merge_allowed then "S" else "s" end)
      + (if .merge_commit_allowed then "M" else "m" end)
      + (if .rebase_merge_allowed then "R" else "r" end)),
    (if (.ruleset // "") == "" then "-" else .ruleset end)
  ] | @tsv
end
'

# shellcheck disable=SC2016
TABLE_FILTER_DEEP='
def b: if . == true then "on" elif . == false then "off" elif . == "n/a" then "n/a" elif . == null then "-" else . end;
def d: if . == null then "-" else . end;
def flag(v; onch; offch): if v == true then onch elif v == false then offch else "?" end;
def codes: {
  "DELETION": "DEL", "NON_FAST_FORWARD": "NFF", "PULL_REQUEST": "PR",
  "REQUIRED_STATUS_CHECKS": "RSC", "REQUIRED_SIGNATURES": "SIG",
  "CREATION": "CRE", "UPDATE": "UPD", "REQUIRED_LINEAR_HISTORY": "LIN",
  "COMMIT_MESSAGE_PATTERN": "CMP", "COPILOT_CODE_REVIEW": "CCR",
  "MERGE_QUEUE": "MQ"
};
def rule_code: (codes[.] // .[0:3]);
if .error then
  [.repo, "ERROR"] + [range(23) | "-"] + ["not found or no access"] | @tsv
else
  (.rulesets[0]) as $rs |
  [
    .repo,
    (.visibility // "-"),
    (flag(.is_template; "T"; "t")
      + flag(.archived; "A"; "a")
      + flag(.has_discussions; "D"; "d")
      + flag(.has_pages; "P"; "p")
      + flag(.allow_forking; "F"; "f")
      + flag(.web_commit_signoff_required; "S"; "s")),
    (.has_wiki | b),
    (.has_projects | b),
    (.pull_requests.delete_branch_on_merge | b),
    (.pull_requests.allow_update_branch | b),
    (.pull_requests.allow_auto_merge | b),
    ((if .pull_requests.allow_squash_merge then "S" else "s" end)
      + (if .pull_requests.allow_merge_commit then "M" else "m" end)
      + (if .pull_requests.allow_rebase_merge then "R" else "r" end)),
    (.security_and_analysis.secret_scanning | b),
    (.security_and_analysis.secret_scanning_push_protection | b),
    (.security_and_analysis.secret_scanning_non_provider_patterns | b),
    (.security_and_analysis.secret_scanning_validity_checks | b),
    (.security_and_analysis.dependabot_security_updates | b),
    (.security_and_analysis.vulnerability_alerts_enabled | b),
    (.security_and_analysis.automated_security_fixes_enabled | b),
    (.security_and_analysis.private_vulnerability_reporting_enabled | b),
    (.actions.enabled | b),
    (.actions.allowed_actions | d),
    (.actions.sha_pinning_required | b),
    (.actions.default_workflow_permissions | d),
    (.actions.can_approve_pull_request_reviews | b),
    (.actions.access_level | d),
    (.releases.immutable_releases_enabled | b),
    (if $rs == null then "-"
     else
       ([$rs.rule_types[]? | rule_code] | join(","))
       + (if (.rulesets | length) > 1 then " (+\((.rulesets | length) - 1))" else "" end)
     end),
    (if ($rs.pull_request_parameters // null) == null then "-"
     else
       "RTR:" + (if $rs.pull_request_parameters.required_review_thread_resolution then "on" else "off" end)
       + ",ARC:" + ($rs.pull_request_parameters.required_approving_review_count // 0 | tostring)
       + ",MRG:" + (
           (if ($rs.pull_request_parameters.allowed_merge_methods // [] | index("squash")) then "S" else "s" end)
           + (if ($rs.pull_request_parameters.allowed_merge_methods // [] | index("merge")) then "M" else "m" end)
           + (if ($rs.pull_request_parameters.allowed_merge_methods // [] | index("rebase")) then "R" else "r" end)
         )
     end)
  ] | @tsv
end
'

if [ "$DEEP" -eq 1 ]; then
  {
    printf 'REPO\tVIS\tFLAGS\tWIKI\tPROJ\tDELBR\tUPDBR\tAUTOMRG\tMERGE\tSECSCAN\tPUSHPROT\tNONPROV\tVALCHK\tDEPSEC\tVULNALRT\tAUTOFIX\tPRIVVULN\tACTENB\tALLOWACT\tSHAPIN\tWFPERM\tAPPRVPR\tACCESSLV\tIMMUT\tRULETYPE\tPRPARAMS\n'
    for obj in "${ALL_JSON[@]}"; do
      printf '%s' "$obj" | jq -r "$TABLE_FILTER_DEEP"
    done
  } | column -t -s "$(printf '\t')"
  echo
  echo "FLAGS legend: t=template a=archived d=discussions p=pages f=forking s=web-signoff (uppercase=on)"
  echo "RULETYPE/PRPARAMS show the first ruleset only — use --deep --json for full multi-ruleset detail."
  echo "'n/a' = not applicable/unavailable for this repo (e.g. GHAS on a private repo, org-only feature on a user account)."
else
  {
    printf 'REPO\tVIS\tWIKI\tPROJ\tDELBR\tUPDBR\tMERGE\tRULESET\n'
    for obj in "${ALL_JSON[@]}"; do
      printf '%s' "$obj" | jq -r "$TABLE_FILTER_LIGHT"
    done
  } | column -t -s "$(printf '\t')"
  echo
  echo "Re-run with --deep for the full lever catalog (security, actions, releases, pages, environments, ...)."
fi
