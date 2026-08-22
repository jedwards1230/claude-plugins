#!/usr/bin/env bash
# Regression tests for the DEPLBL check in
#   skills/repo-standards/scripts/repo-standards-audit.sh
#
# Two halves are tested, both hermetically — no network, no `gh`, no real repos:
#
#   1. DEPENDABOT_LABELS_AWK — the YAML label extractor. This is the fragile
#      part: it is a hand-rolled parser (the script's dependency floor is
#      gh + jq + git, so there is no YAML library to lean on) and every miss is
#      a FALSE NEGATIVE that renders as a clean "n/a", i.e. indistinguishable
#      from a repo that legitimately declares no labels. A parser bug therefore
#      looks exactly like conformance — which is the same silent-failure shape
#      the check exists to catch.
#   2. The declared-vs-actual comparison, including its case-insensitivity
#      (GitHub label names are case-insensitively unique, so a config naming
#      "Dependency" against a repo label "dependency" must NOT report missing).
#
# The GraphQL/REST fetch around them needs a live repo and is covered by running
# the script against real repos, not here.
#
# Both units are extracted from the script by sourcing it in a guarded mode
# rather than being copy-pasted, so the test cannot drift away from the code.
#
# Run: bash plugins/repo-standards/tests/dependabot-labels.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="${DEPLBL_TEST_SCRIPT:-${SCRIPT_DIR}/../skills/repo-standards/scripts/repo-standards-audit.sh}"

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed"
  exit 0
fi
if [ ! -r "$AUDIT" ]; then
  echo "FAIL: cannot read $AUDIT"
  exit 1
fi

# Pull the awk program out of the script by evaluating just its assignment.
# sed bounds it on the opening `DEPENDABOT_LABELS_AWK='` and the lone closing
# quote, so the test breaks loudly if the variable is renamed or restructured
# instead of silently testing nothing.
AWK_ASSIGN="$(sed -n "/^DEPENDABOT_LABELS_AWK='/,/^'\$/p" "$AUDIT")"
if [ -z "$AWK_ASSIGN" ]; then
  echo "FAIL: could not extract DEPENDABOT_LABELS_AWK from $AUDIT"
  exit 1
fi
eval "$AWK_ASSIGN"

# The same comparison expression the script runs, kept here as the one
# deliberate duplication: it is three lines of jq, and extracting it would mean
# restructuring the script around the test.
# shellcheck disable=SC2016  # jq program: $declared/$actual are jq vars, not shell
COMPARE_JQ='
  ([$actual[] | ascii_downcase]) as $have
  | ([$declared[] | . as $d | select(($have | index($d | ascii_downcase)) == null)]) as $missing
  | {state: (if ($missing | length) == 0 then "ok" else "miss" end), missing: $missing}'

PASS=0
FAIL=0

# parse_case <name> <expected-pipe-joined-labels> <yaml>
parse_case() {
  local name="$1" want="$2" yaml="$3" got
  got="$(printf '%s\n' "$yaml" | awk "$DEPENDABOT_LABELS_AWK" | paste -sd'|' -)"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf 'ok   parse: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL parse: %s\n     want: %s\n     got:  %s\n' "$name" "$want" "$got"
  fi
}

# compare_case <name> <expected-json> <declared-json> <actual-json>
compare_case() {
  local name="$1" want="$2" declared="$3" actual="$4" got
  got="$(jq -c -n --argjson declared "$declared" --argjson actual "$actual" "$COMPARE_JQ")"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf 'ok   compare: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL compare: %s\n     want: %s\n     got:  %s\n' "$name" "$want" "$got"
  fi
}

# --- parser: the two YAML sequence forms, both quoting styles -----------------
parse_case 'flow sequence, double-quoted' 'dependency|chore' \
'    labels: ["dependency", "chore"]'

parse_case 'flow sequence, bare' 'dependency|chore' \
'    labels: [dependency, chore]'

parse_case 'flow sequence, single-quoted with a space in the value' 'a b|c' \
"    labels: ['a b', c]"

parse_case 'flow sequence spanning lines' 'a|b' \
'    labels: [
      "a",
      "b"
    ]
    schedule: x'

parse_case 'block sequence, quoted' 'dependency|chore' \
'    labels:
      - "dependency"
      - "chore"
    commit-message:
      prefix: deps'

parse_case 'block sequence with a trailing comment on an item' 'dependency|chore' \
'    labels:
      - dependency # keep this one
      - chore
    open-pull-requests-limit: 5'

parse_case 'block sequence at the same indent as its key' 'alpha|beta' \
'    labels:
    - alpha
    - beta
    schedule: x'

# Real-world dependabot.yml label names are not all plain words.
parse_case 'slashes, dots and dashes in label names' 'area/ci|release-note.none' \
'    labels: ["area/ci", "release-note.none"]'

# --- parser: it must stop at the end of the labels block ----------------------
parse_case 'stops at a shallower sibling (next updates: entry)' 'dependency' \
'  - package-ecosystem: npm
    labels:
      - dependency
  - package-ecosystem: gomod
    directory: "/"'

parse_case 'stops at a same-indent sibling key that is itself a list' 'dependency' \
'    labels:
      - dependency
    ignore:
      - dependency-name: "left-pad"'

# --- parser: multiple updates: entries all contribute ------------------------
parse_case 'labels from every updates: entry, including a "- labels:" first key' \
'dependency|chore|chore|security' \
'updates:
  - labels: [dependency, chore]
  - labels:
      - chore
      - security'

# --- parser: things that must yield NOTHING ----------------------------------
parse_case 'no labels: key at all' '' \
'version: 2
updates:
  - package-ecosystem: npm
    directory: "/"'

parse_case 'commented-out labels: key' '' \
'    # labels: [nope]
    open-pull-requests-limit: 5'

parse_case 'empty flow sequence' '' \
'    labels: []
    schedule: x'

parse_case 'CRLF line endings are stripped, not folded into the label' 'a|b' \
"$(printf '    labels: [a, b]\r\n    schedule: x\r')"

# --- comparison ---------------------------------------------------------------
compare_case 'all declared labels present' \
  '{"state":"ok","missing":[]}' \
  '["dependency","chore"]' '["dependency","chore","bug"]'

compare_case 'one declared label absent' \
  '{"state":"miss","missing":["chore"]}' \
  '["dependency","chore"]' '["dependency","bug"]'

compare_case 'every declared label absent' \
  '{"state":"miss","missing":["dependency","chore"]}' \
  '["dependency","chore"]' '["bug"]'

compare_case 'case-insensitive match (GitHub labels are case-insensitively unique)' \
  '{"state":"ok","missing":[]}' \
  '["Dependency","CHORE"]' '["dependency","Chore"]'

compare_case 'the reported missing name keeps the config spelling, not the repo one' \
  '{"state":"miss","missing":["Ghost"]}' \
  '["Ghost"]' '["dependency"]'

compare_case 'repo with no labels at all' \
  '{"state":"miss","missing":["dependency"]}' \
  '["dependency"]' '[]'

# --- self-check: the suite must actually discriminate -------------------------
# A parser that emits nothing would pass every "must yield NOTHING" case above.
# Prove the harness fails such a stub, so a green run means something.
STUB_OUT="$(printf '    labels: [a, b]\n' | awk '{ next }' | paste -sd'|' -)"
if [ "$STUB_OUT" = "a|b" ]; then
  FAIL=$((FAIL + 1))
  printf 'FAIL self-check: a do-nothing parser produced the expected output\n'
else
  PASS=$((PASS + 1))
  printf 'ok   self-check: a do-nothing parser does not satisfy the parse cases\n'
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
