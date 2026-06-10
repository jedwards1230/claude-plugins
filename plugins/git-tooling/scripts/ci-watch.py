#!/usr/bin/env python3
"""ci-watch.py — Watch GitHub PR CI status through to merge.

Emits one stdout line per state transition. Exits 0 when every watched PR
reaches a true terminal state: MERGED, CLOSED, or GONE. CI completion and
review status are reported as intermediate milestones (with a READY flag
when a PR is mergeable), but the watcher keeps polling until the PR is
actually merged or closed.

Designed to be invoked via the Monitor tool from the ci-watch skill —
each stdout line becomes a notification.

Usage:
    ci-watch.py                       # watch all open PRs in current repo
    ci-watch.py <pr> [pr...]          # watch specific PR numbers (current repo)
    ci-watch.py -R owner/repo [pr...] # ...in a specific repo (all open if no PRs)
    ci-watch.py owner/repo#N ...      # watch PRs across multiple repos in one call
    ci-watch.py owner/repo            # all open PRs in an explicit repo

Forms mix freely, e.g.:
    ci-watch.py -R me/api 12 13 me/web#4   # PRs 12,13 in me/api + PR 4 in me/web

Env:
    GIT_TOOLING_CI_POLL_SECONDS   poll interval in seconds (default 30)

Requires: python3 (3.8+), gh (authenticated).
Portable across macOS and Linux — no shell-version dependencies.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from typing import Optional


def die(msg: str, code: int = 1) -> None:
    print(f"ci-watch: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def emit(line: str) -> None:
    print(line, flush=True)


def run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True)


def detect_repo() -> Optional[str]:
    p = run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    if p.returncode != 0:
        return None
    repo = p.stdout.strip()
    return repo or None


def list_open_prs(repo: str) -> list[int]:
    p = run(["gh", "pr", "list", "-R", repo, "--state", "open",
             "--json", "number", "-q", ".[].number"])
    if p.returncode != 0:
        return []
    return [int(x) for x in p.stdout.split() if x.strip()]


GRAPHQL_QUERY = """
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      state
      mergeable
      mergeStateStatus
      reviewRequests(first: 1) { totalCount }
      reviewThreads(first: 50) { nodes { isResolved } }
      latestReviews(first: 10) { nodes { state } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}
""".strip()


class QueryResult:
    """Outcome of a single graphql query for a PR.

    - `node`: the pullRequest node when the API replies successfully.
    - `gone`: True iff the API affirmatively returned `pullRequest: null`
      (the PR truly doesn't exist). Distinct from a transient API error.
    - `transient_error`: True iff `gh api` failed, returned malformed JSON,
      or returned a top-level GraphQL `errors` array. Caller should keep
      polling and not change the PR's known state.
    """

    __slots__ = ("node", "gone", "transient_error")

    def __init__(self, node=None, gone=False, transient_error=False):
        self.node = node
        self.gone = gone
        self.transient_error = transient_error


def query_pr(owner: str, name: str, pr: int) -> QueryResult:
    p = run([
        "gh", "api", "graphql",
        "-f", f"query={GRAPHQL_QUERY}",
        # owner/name are String! — use -f (string-typed). -F would coerce
        # all-digit values (e.g. repo "octocat/123") to Int and the API
        # would reject the query with a type error.
        "-f", f"owner={owner}",
        "-f", f"name={name}",
        # pr is Int! — -F sends it typed.
        "-F", f"pr={pr}",
    ])

    # Parse stdout regardless of exit code: gh returns a fully-formed JSON
    # body (with an `errors` array) for NOT_FOUND responses even though it
    # also exits 1.
    try:
        data = json.loads(p.stdout) if p.stdout else {}
    except json.JSONDecodeError:
        return QueryResult(transient_error=True)

    # A NOT_FOUND error for `repository.pullRequest` is GitHub's authoritative
    # "this PR doesn't exist" reply — treat it as truly gone. Any other
    # error class (rate limit, network, server-side) is transient.
    for err in (data.get("errors") or []):
        if (err.get("type") == "NOT_FOUND"
                and err.get("path") == ["repository", "pullRequest"]):
            return QueryResult(gone=True)
    if p.returncode != 0 or data.get("errors"):
        return QueryResult(transient_error=True)

    repo = (data.get("data") or {}).get("repository")
    if repo is None:
        return QueryResult(transient_error=True)
    pr_node = repo.get("pullRequest")
    if pr_node is None:
        # Defensive: success response with null pullRequest (no errors
        # surfaced) — rare in practice; treat as gone.
        return QueryResult(gone=True)
    return QueryResult(node=pr_node)


def _count(items: list, predicate) -> int:
    return sum(1 for x in items if x and predicate(x))


def build_signature(owner: str, name: str, pr: int) -> tuple[str, bool, bool]:
    """Return (signature, terminal, should_emit).

    On transient API errors, returns ("", False, False) — caller should
    skip the emit, leave previous[pr] unchanged, and keep polling so a
    one-off network blip doesn't masquerade as a state transition or
    falsely declare every watched PR terminal at once.
    """
    result = query_pr(owner, name, pr)
    if result.transient_error:
        return ("", False, False)
    if result.gone:
        return ("GONE", True, True)
    node = result.node

    state = node.get("state") or "UNKNOWN"
    if state in ("MERGED", "CLOSED"):
        return (state, True, True)

    # Pull check contexts off the latest commit; default to empty when missing.
    commits = (node.get("commits") or {}).get("nodes") or []
    contexts: list[dict] = []
    if commits:
        rollup = ((commits[0] or {}).get("commit") or {}).get("statusCheckRollup") or {}
        contexts = ((rollup.get("contexts") or {}).get("nodes") or [])

    def _conclusion(c: dict) -> str:
        return c.get("conclusion") or ""

    def _status(c: dict) -> str:
        return c.get("status") or ""

    def _state(c: dict) -> str:
        return c.get("state") or ""

    passed = _count(contexts, lambda c: _conclusion(c) == "SUCCESS" or _state(c) == "SUCCESS")
    failed = _count(contexts, lambda c: _conclusion(c) in ("FAILURE", "TIMED_OUT")
                                       or _state(c) in ("FAILURE", "ERROR"))
    pending = _count(contexts, lambda c: _status(c) in ("QUEUED", "WAITING", "IN_PROGRESS")
                                        or _state(c) == "PENDING")

    mergeable = node.get("mergeable") or "UNKNOWN"
    # mergeStateStatus is GitHub's authoritative merge-readiness verdict. Unlike
    # the per-signal counts below (which only catch the blockers we explicitly
    # query), BLOCKED captures *every* merge gate — unresolved review threads,
    # required/conversation-resolution, ruleset rules (e.g. required Copilot or
    # CODEOWNERS review), and required status checks — so a blocking review
    # comment we don't individually track still prevents a false READY.
    merge_state = node.get("mergeStateStatus") or "UNKNOWN"
    unresolved = _count((node.get("reviewThreads") or {}).get("nodes") or [],
                       lambda t: t.get("isResolved") is False)
    changes_requested = _count((node.get("latestReviews") or {}).get("nodes") or [],
                              lambda r: r.get("state") == "CHANGES_REQUESTED")

    # Pending review requests: includes auto-requested Copilot reviews. The
    # request stays in `reviewRequests` until the reviewer posts a review,
    # so watching for `totalCount == 0` keeps us polling until Copilot (or
    # any other requested reviewer) has weighed in.
    review_requests = ((node.get("reviewRequests") or {}).get("totalCount") or 0)

    parts = [f"P={passed}", f"F={failed}", f"W={pending}"]
    if mergeable == "CONFLICTING":
        parts.append("CONFLICT")
    if changes_requested > 0:
        parts.append("CR")
    if unresolved > 0:
        parts.append(f"U={unresolved}")
    if review_requests > 0:
        parts.append(f"RR={review_requests}")
    # Surface a generic block (a required review/ruleset/check or a blocking
    # comment) that the counts above didn't already explain.
    if merge_state == "BLOCKED" and not (changes_requested or unresolved or review_requests):
        parts.append("BLOCKED")

    # READY requires both: our tracked signals are clear AND GitHub does not
    # report the PR as blocked/dirty/behind/draft. The merge_state gate is what
    # generalizes READY to *any* blocking condition, not just the ones we count.
    ready = (pending == 0 and failed == 0 and review_requests == 0
             and changes_requested == 0 and unresolved == 0
             and mergeable != "CONFLICTING"
             and merge_state not in ("BLOCKED", "DIRTY", "BEHIND", "DRAFT"))
    if ready:
        parts.append("READY")

    # Terminal = merged/closed/gone only (handled by early returns above).
    terminal = False
    return (",".join(parts), terminal, True)


def valid_repo(repo: str) -> bool:
    """True iff `repo` is exactly `owner/name` with both parts non-empty.

    Guards against tokens that contain a slash but aren't a real repo slug
    (e.g. `owner/repo/extra`, `/repo`, `owner/`) — they'd otherwise slip
    through and fail opaquely later inside `gh`.
    """
    parts = repo.split("/")
    return len(parts) == 2 and all(parts)


def parse_args(argv: list[str]) -> tuple[Optional[str], "dict[Optional[str], list[int]]"]:
    """Parse CLI args into (default_repo, repo_prs).

    Accepted token forms, mixable in one invocation:
      -R owner/repo     set the default repo for bare PR numbers that follow
      <N>               PR number N in the default/detected repo
      owner/repo#<N>    PR number N in an explicit repo (cross-repo batches)
      owner/repo        all open PRs in an explicit repo

    repo_prs maps a repo key -> explicit PR numbers; an empty list means
    "all open PRs in that repo". The key None stands for the default repo,
    resolved later from -R or repo auto-detection.
    """
    default_repo: Optional[str] = None
    repo_prs: "dict[Optional[str], list[int]]" = {}
    tokens = list(argv)
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "-R":
            if i + 1 >= len(tokens):
                die("missing repo for -R flag")
            default_repo = tokens[i + 1]
            i += 2
            continue
        if "#" in t:
            repo_part, _, num = t.rpartition("#")
            if not valid_repo(repo_part) or not num.isdigit():
                die(f"invalid target {t!r}; expected owner/repo#N")
            repo_prs.setdefault(repo_part, []).append(int(num))
        elif t.isdigit():
            repo_prs.setdefault(None, []).append(int(t))
        elif "/" in t:
            if not valid_repo(t):
                die(f"invalid repo {t!r}; expected owner/name")
            repo_prs.setdefault(t, [])  # all open PRs in this repo
        else:
            die(f"unrecognized argument {t!r}; expected a PR number, "
                f"owner/repo, owner/repo#N, or -R owner/repo")
        i += 1
    return default_repo, repo_prs


def parse_poll_interval() -> int:
    raw = os.environ.get("GIT_TOOLING_CI_POLL_SECONDS", "30").strip()
    if not raw:
        return 30
    try:
        value = int(raw)
    except ValueError:
        die(f"GIT_TOOLING_CI_POLL_SECONDS={raw!r} is not an integer")
    if value < 1:
        die(f"GIT_TOOLING_CI_POLL_SECONDS={raw!r} must be >= 1")
    return value


def main(argv: list[str]) -> int:
    poll = parse_poll_interval()

    if not shutil.which("gh"):
        die("gh not found")
    if run(["gh", "auth", "status"]).returncode != 0:
        die("gh not authenticated")

    default_repo, repo_prs = parse_args(argv)
    if not repo_prs:
        repo_prs = {None: []}

    # Resolve the None (default) key to a concrete repo, merging any bare PR
    # numbers into it. detect_repo() only runs when a default repo is needed.
    if None in repo_prs:
        base = default_repo or detect_repo()
        if not base:
            die("cannot determine GitHub repo (run inside a repo, or pass "
                "-R owner/name or owner/repo#N targets)")
        bare_prs = repo_prs.pop(None)
        repo_prs.setdefault(base, [])
        for n in bare_prs:
            if n not in repo_prs[base]:
                repo_prs[base].append(n)

    # Expand "all open" (empty list) selections into a flat, ordered list of
    # (repo, pr) targets. PR numbers can collide across repos, so the repo is
    # part of every target's identity.
    targets: "list[tuple[str, int]]" = []
    for repo, prs in repo_prs.items():
        if not valid_repo(repo):
            die(f"invalid repo {repo!r}; expected owner/name")
        selected = prs if prs else list_open_prs(repo)
        for n in selected:
            if (repo, n) not in targets:
                targets.append((repo, n))

    repos_list = ", ".join(dict.fromkeys(repo_prs.keys()))
    if not targets:
        emit(f"ci-watch: no open PRs to watch in {repos_list}")
        return 0

    # Only label lines with the repo when watching more than one — keeps the
    # familiar `PR #N` output for the common single-repo case.
    multi_repo = len({r for r, _ in targets}) > 1

    def label(repo: str, pr: int) -> str:
        return f"{repo}#{pr}" if multi_repo else f"PR #{pr}"

    emit(f"ci-watch: watching {len(targets)} PR(s) in {repos_list} "
         f"(poll every {poll}s)")

    previous: "dict[tuple[str, int], str]" = {}
    while True:
        all_terminal = True
        for repo, pr in targets:
            owner, name = repo.split("/", 1)
            sig, terminal, should_emit = build_signature(owner, name, pr)
            if not terminal:
                # Transient errors also fall through here (terminal=False,
                # should_emit=False), so a one-off API blip never lets the
                # loop conclude "all watched PRs reached terminal state".
                all_terminal = False
            key = (repo, pr)
            if should_emit and (key not in previous or sig != previous[key]):
                emit(f"{label(repo, pr)}: {sig}")
                previous[key] = sig

        if all_terminal:
            emit("ci-watch: all watched PRs reached a terminal state")
            return 0

        all_ready = previous and all(
            sig.endswith("READY") for sig in previous.values()
        )
        time.sleep(poll * 2 if all_ready else poll)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
