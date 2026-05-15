#!/usr/bin/env python3
"""ci-watch.py — Watch GitHub PR CI status.

Emits one stdout line per state transition. Exits 0 when every watched PR
reaches a terminal state (no pending checks, or MERGED/CLOSED/GONE).

Designed to be invoked via the Monitor tool from the ci-watch skill —
each stdout line becomes a notification.

Usage:
    ci-watch.py                # watch all open PRs in current repo
    ci-watch.py <pr> [pr...]   # watch specific PR numbers
    ci-watch.py -R owner/repo  # ...in a specific repo (combine with PR list)

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


def query_pr(owner: str, name: str, pr: int) -> Optional[dict]:
    """Return the pullRequest node, or None on API error / not found."""
    p = run([
        "gh", "api", "graphql",
        "-f", f"query={GRAPHQL_QUERY}",
        "-F", f"owner={owner}",
        "-F", f"name={name}",
        "-F", f"pr={pr}",
    ])
    if p.returncode != 0:
        return None
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        return None
    return ((data.get("data") or {}).get("repository") or {}).get("pullRequest")


def _count(items: list, predicate) -> int:
    return sum(1 for x in items if x and predicate(x))


def build_signature(owner: str, name: str, pr: int) -> tuple[str, bool]:
    """Return (signature, terminal). signature is the line content after 'PR #N: '."""
    node = query_pr(owner, name, pr)
    if not node:
        return ("GONE", True)

    state = node.get("state") or "UNKNOWN"
    if state in ("MERGED", "CLOSED"):
        return (state, True)

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
    unresolved = _count((node.get("reviewThreads") or {}).get("nodes") or [],
                       lambda t: t.get("isResolved") is False)
    changes_requested = _count((node.get("latestReviews") or {}).get("nodes") or [],
                              lambda r: r.get("state") == "CHANGES_REQUESTED")

    parts = [f"P={passed}", f"F={failed}", f"W={pending}"]
    if mergeable == "CONFLICTING":
        parts.append("CONFLICT")
    if changes_requested > 0:
        parts.append("CR")
    if unresolved > 0:
        parts.append(f"U={unresolved}")

    return (",".join(parts), pending == 0)


def parse_args(argv: list[str]) -> tuple[Optional[str], list[int]]:
    repo: Optional[str] = None
    args = list(argv)
    if args and args[0] == "-R":
        if len(args) < 2:
            die("missing repo for -R flag")
        repo = args[1]
        args = args[2:]
    try:
        prs = [int(x) for x in args]
    except ValueError:
        die(f"PR numbers must be integers, got: {args!r}")
    return repo, prs


def main(argv: list[str]) -> int:
    poll = int(os.environ.get("GIT_TOOLING_CI_POLL_SECONDS", "30"))

    if not shutil.which("gh"):
        die("gh not found")
    if run(["gh", "auth", "status"]).returncode != 0:
        die("gh not authenticated")

    repo, pr_nums = parse_args(argv)
    if not repo:
        repo = detect_repo()
    if not repo:
        die("cannot determine GitHub repo (run inside a repo, or pass -R owner/name)")
    if "/" not in repo:
        die(f"invalid repo {repo!r}; expected owner/name")
    owner, name = repo.split("/", 1)

    if not pr_nums:
        pr_nums = list_open_prs(repo)
    if not pr_nums:
        emit(f"ci-watch: no open PRs to watch in {repo}")
        return 0

    emit(f"ci-watch: watching {len(pr_nums)} PR(s) in {repo} (poll every {poll}s)")

    previous: dict[int, str] = {}
    first_poll = True
    while True:
        all_terminal = True
        for pr in pr_nums:
            sig, terminal = build_signature(owner, name, pr)
            if not terminal:
                all_terminal = False
            if first_poll or sig != previous.get(pr):
                emit(f"PR #{pr}: {sig}")
            previous[pr] = sig
        first_poll = False

        if all_terminal:
            emit("ci-watch: all watched PRs reached a terminal state")
            return 0
        time.sleep(poll)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
