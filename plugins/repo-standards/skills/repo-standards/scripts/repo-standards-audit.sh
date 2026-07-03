#!/usr/bin/env bash
# repo-standards-audit.sh — portable audit of repo-standards conformance fields.
#
# Reports, per repo: visibility, wiki/projects toggles, delete-branch-on-merge,
# allow-update-branch, allowed merge methods, the main/default-branch ruleset(s),
# and (with --deep) secret-scanning / push-protection / Dependabot security-updates
# status. Works against ANY GitHub repo you can `gh api` — no monorepo, no
# hardcoded owner/org, no repos.conf. Requires `gh` (authenticated) and `jq`.
#
# See --help for usage, input modes, and the rate-limit/batching design.
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
  --deep          Also fetch secret-scanning / push-protection / Dependabot
                   security-updates status (1 extra REST call per repo).
                   Off by default; those columns show '-' without it.
  --json          Emit a JSON array instead of the table.
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
  repo-standards-audit.sh org/repo-a --json | jq .

RATE LIMITS
  The bulk fields (visibility, wiki/projects, delete/update-branch, merge
  methods, rulesets) come from ONE batched GraphQL query per ~20-repo chunk
  (aliased repository() blocks) — GraphQL has its own 5000-point/hr budget,
  separate from REST, and a chunked query costs roughly 1 request regardless
  of how many repos are in it. `--deep` adds one REST call per repo (against
  the 5000/hr REST budget) for the three fields the GraphQL API does not
  expose (secret scanning, push protection, Dependabot security updates) —
  keep it off for large batches unless you need those columns.

COLUMNS
  VIS      visibility (public/private/internal)
  WIKI     has_wiki (on = wiki enabled)
  PROJ     has_projects (on = projects enabled)
  DELBR    delete_branch_on_merge
  UPDBR    allow_update_branch
  SECSCAN  secret scanning status (--deep only)
  PUSHPROT secret scanning push-protection status (--deep only)
  DEPSEC   Dependabot security-updates status (--deep only)
  MERGE    allowed merge methods: S/M/R = squash/merge-commit/rebase,
           uppercase = allowed, lowercase = disabled (e.g. "SmR")
  RULESET  main/default-branch ruleset(s) as "name/enforcement"; "-" if none

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
# ---------------------------------------------------------------------------
RESOLVED=()
SEEN="|"
for raw in "${RAW[@]}"; do
  slug="$(resolve_target "$raw")" || continue
  case "$SEEN" in
    *"|$slug|"*) continue ;;
  esac
  SEEN="${SEEN}${slug}|"
  RESOLVED+=("$slug")
done

if [ "${#RESOLVED[@]}" -eq 0 ]; then
  echo "$SCRIPT_NAME: no resolvable repos to audit" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# GraphQL: batch the cheap, bulk-fetchable fields, ~20 repos per request.
# ---------------------------------------------------------------------------
CHUNK_SIZE=20
GQL_FIELDS='nameWithOwner visibility hasWikiEnabled hasProjectsEnabled deleteBranchOnMerge allowUpdateBranch mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed rulesets(first: 10) { nodes { name enforcement } }'

# fetch_graphql_chunk <slug> [<slug> ...] — one batched query for the whole chunk.
fetch_graphql_chunk() {
  local -a chunk=("$@")
  local decl="" aliases="" i owner repo
  local -a gh_args=()
  for i in "${!chunk[@]}"; do
    owner="${chunk[$i]%%/*}"
    repo="${chunk[$i]#*/}"
    decl="${decl}\$owner${i}: String!, \$name${i}: String!, "
    aliases="${aliases}r${i}: repository(owner: \$owner${i}, name: \$name${i}) { ${GQL_FIELDS} } "
    gh_args+=(-f "owner${i}=${owner}" -f "name${i}=${repo}")
  done
  decl="${decl%, }"
  gh api graphql -f "query=query(${decl}) { ${aliases} }" "${gh_args[@]}"
}

# Normalize one GraphQL repository object (or null) into our result schema.
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

# Fetch the --deep-only fields (secret scanning, push protection, Dependabot
# security updates) with a single REST call. Degrades to "n/a" on any
# failure (no admin access, GHAS unavailable on a free private repo, etc).
fetch_deep_fields() {
  local slug="$1" owner repo
  owner="${slug%%/*}"
  repo="${slug#*/}"
  gh api "repos/${owner}/${repo}" --jq '{
    secret_scanning: (.security_and_analysis.secret_scanning.status // "n/a"),
    secret_scanning_push_protection: (.security_and_analysis.secret_scanning_push_protection.status // "n/a"),
    dependabot_security_updates: (.security_and_analysis.dependabot_security_updates.status // "n/a")
  }' 2>/dev/null || printf '%s' '{"secret_scanning":"n/a","secret_scanning_push_protection":"n/a","dependabot_security_updates":"n/a"}'
}

ALL_JSON=()
TOTAL="${#RESOLVED[@]}"
OFFSET=0
GQL_ERR_FILE="$(mktemp)"
trap 'rm -f "$GQL_ERR_FILE"' EXIT

while [ "$OFFSET" -lt "$TOTAL" ]; do
  CHUNK=("${RESOLVED[@]:OFFSET:CHUNK_SIZE}")

  # `gh api graphql` exits non-zero whenever ANY aliased repository() in the
  # chunk hits a partial error (e.g. NOT_FOUND for one bad slug) — even
  # though the JSON body still carries usable data for the rest. Capture
  # stdout regardless of exit code; only treat it as fatal if `.data` itself
  # is missing (auth failure, malformed query, etc.), not a per-repo miss.
  RESPONSE="$(fetch_graphql_chunk "${CHUNK[@]}" 2>"$GQL_ERR_FILE")" || true
  if ! printf '%s' "$RESPONSE" | jq -e 'has("data") and (.data != null)' >/dev/null 2>&1; then
    echo "$SCRIPT_NAME: GraphQL request failed for chunk starting at '${CHUNK[0]}':" >&2
    cat "$GQL_ERR_FILE" >&2
    exit 1
  fi

  for i in "${!CHUNK[@]}"; do
    slug="${CHUNK[$i]}"
    node="$(printf '%s' "$RESPONSE" | jq -c ".data.r${i}")"
    obj="$(normalize_repo_json "$node" "$slug")"

    if [ "$(printf '%s' "$obj" | jq -r '.error')" = "true" ]; then
      obj="$(printf '%s' "$obj" | jq -c '. + {
        secret_scanning: null, secret_scanning_push_protection: null, dependabot_security_updates: null
      }')"
    elif [ "$DEEP" -eq 1 ]; then
      deep_json="$(fetch_deep_fields "$slug")"
      obj="$(jq -c -n --argjson a "$obj" --argjson b "$deep_json" '$a * $b')"
    else
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

TABLE_FILTER='
def b: if . == true then "on" elif . == false then "off" else "-" end;
def d: if . == null then "-" else . end;
if .error then
  [.repo, "ERROR", "-", "-", "-", "-", "-", "-", "-", "-", "not found or no access"] | @tsv
else
  [
    .repo,
    (.visibility // "-"),
    (.has_wiki | b),
    (.has_projects | b),
    (.delete_branch_on_merge | b),
    (.allow_update_branch | b),
    (.secret_scanning | d),
    (.secret_scanning_push_protection | d),
    (.dependabot_security_updates | d),
    ((if .squash_merge_allowed then "S" else "s" end)
      + (if .merge_commit_allowed then "M" else "m" end)
      + (if .rebase_merge_allowed then "R" else "r" end)),
    (if (.ruleset // "") == "" then "-" else .ruleset end)
  ] | @tsv
end
'

{
  printf 'REPO\tVIS\tWIKI\tPROJ\tDELBR\tUPDBR\tSECSCAN\tPUSHPROT\tDEPSEC\tMERGE\tRULESET\n'
  for obj in "${ALL_JSON[@]}"; do
    printf '%s' "$obj" | jq -r "$TABLE_FILTER"
  done
} | column -t -s "$(printf '\t')"

if [ "$DEEP" -eq 0 ]; then
  echo
  echo "SECSCAN/PUSHPROT/DEPSEC show '-' — re-run with --deep to fetch them (1 extra REST call/repo)."
fi
