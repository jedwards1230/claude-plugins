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

Polling cadence adapts on its own: it doubles once every watched PR is READY
(to ease off while waiting on a human to merge), and it backs off exponentially
(capped at 5 min) when the GitHub API is returning errors, so a rate-limit or
outage isn't hammered. Persistent unreadability is surfaced as a one-time WARN
line rather than silently swallowed.

Requires: python3 (3.8+), gh (authenticated).
Portable across macOS and Linux — no shell-version dependencies.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from typing import Optional

# Consecutive transient-error count at which a PR earns a one-time WARN line so
# the user knows the watcher is stuck retrying rather than silently idle.
ERROR_WARN_THRESHOLD = 3
# Streak at which inter-poll backoff kicks in, and the ceiling it backs off to.
ERROR_BACKOFF_THRESHOLD = 3
ERROR_BACKOFF_MAX_SECONDS = 300
# PRs fetched per GraphQL request. One aliased query covers a whole chunk, so a
# large multi-repo batch costs ceil(N/BATCH_CHUNK) requests per poll instead of
# N. Kept modest to stay well under GitHub's GraphQL node/complexity limits
# given the per-PR reviewThreads/contexts/latestReviews pages below.
BATCH_CHUNK = 10


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
    # A hard failure here (auth, network, bad repo) used to be swallowed as
    # "no open PRs", and the watcher would exit 0 having watched nothing. This
    # runs once at startup, so failing loudly lets the user re-invoke.
    if p.returncode != 0:
        die(f"failed to list open PRs in {repo}: "
            f"{p.stderr.strip() or 'gh error'}")
    return [int(x) for x in p.stdout.split() if x.strip()]


# Shared PR field selection, aliased into the batch query once per watched PR.
# reviewThreads/latestReviews are paged generously (100/50) so PRs with many
# threads or reviewers don't undercount unresolved/changes-requested signals;
# the contexts page reports hasNextPage so a PR with >100 checks is flagged
# (TRUNC) rather than silently undercounted.
PR_FRAGMENT = """
fragment PR on PullRequest {
  state
  isDraft
  mergeable
  mergeStateStatus
  headRefName
  baseRefName
  timelineItems(itemTypes: [CONVERT_TO_DRAFT_EVENT], last: 1) {
    nodes {
      ... on ConvertToDraftEvent { actor { login } }
    }
  }
  reviewRequests(first: 1) { totalCount }
  reviewThreads(first: 100) { nodes { isResolved } }
  latestReviews(first: 50) { nodes { state } }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
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
""".strip()


def build_batch_query(n: int) -> str:
    """Build a GraphQL query that fetches `n` PRs in one request via aliases.

    Each target gets an `r{i}: repository(...) { pullRequest(...) { ...PR } }`
    alias driven by typed variables ($o{i}/$n{i}/$p{i}) so owner/name/number are
    never string-interpolated into the query body — no injection surface even if
    a repo slug contained query-significant characters.
    """
    decls = []
    bodies = []
    for i in range(n):
        decls.append(f"$o{i}: String!, $n{i}: String!, $p{i}: Int!")
        bodies.append(
            f"  r{i}: repository(owner: $o{i}, name: $n{i}) "
            f"{{ pullRequest(number: $p{i}) {{ ...PR }} }}"
        )
    return "query(" + ", ".join(decls) + ") {\n" + "\n".join(bodies) + "\n}\n" + PR_FRAGMENT


class QueryResult:
    """Outcome of a single PR lookup within a batch.

    - `node`: the pullRequest node when the API replies successfully.
    - `gone`: True iff the API affirmatively returned NOT_FOUND for this PR's
      repository/pullRequest (it truly doesn't exist). Distinct from a transient
      error.
    - `transient_error`: True iff the request failed, returned malformed JSON,
      or this alias came back null without a NOT_FOUND. Caller should keep
      polling and not change the PR's known state.
    """

    __slots__ = ("node", "gone", "transient_error")

    def __init__(self, node=None, gone=False, transient_error=False):
        self.node = node
        self.gone = gone
        self.transient_error = transient_error


def query_batch(chunk: "list[tuple[str, int]]") -> "dict[tuple[str, int], QueryResult]":
    """Fetch a chunk of (repo, pr) targets in one aliased GraphQL request.

    Returns a result per target. Partial failures are handled per-alias: a
    NOT_FOUND alias becomes `gone`, an alias that simply came back null (rate
    limit / server error on that subtree) becomes a transient error, and the
    rest resolve normally. A whole-request failure marks every target transient.
    """
    n = len(chunk)
    query = build_batch_query(n)
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for i, (repo, pr) in enumerate(chunk):
        owner, name = repo.split("/", 1)
        # owner/name are String! → -f (string-typed); pr is Int! → -F (typed).
        args += ["-f", f"o{i}={owner}", "-f", f"n{i}={name}", "-F", f"p{i}={pr}"]

    p = run(args)

    # Parse stdout regardless of exit code: gh returns a fully-formed JSON body
    # (with an `errors` array) for NOT_FOUND / FORBIDDEN responses even when it
    # also exits non-zero.
    try:
        data = json.loads(p.stdout) if p.stdout else None
    except json.JSONDecodeError:
        data = None

    out: "dict[tuple[str, int], QueryResult]" = {}
    if not isinstance(data, dict):
        for target in chunk:
            out[target] = QueryResult(transient_error=True)
        return out

    # Aliases the API affirmatively reported as NOT_FOUND — either the repository
    # (path == ["r{i}"]) or the pull request (path == ["r{i}", "pullRequest"]).
    # Both mean "this PR doesn't exist" → gone.
    gone_aliases = set()
    for err in (data.get("errors") or []):
        if err.get("type") != "NOT_FOUND":
            continue
        path = err.get("path") or []
        if path and isinstance(path[0], str) and path[0].startswith("r"):
            gone_aliases.add(path[0])

    dnode = data.get("data")
    if not isinstance(dnode, dict):
        dnode = {}

    for i, target in enumerate(chunk):
        alias = f"r{i}"
        rnode = dnode.get(alias)
        prnode = rnode.get("pullRequest") if isinstance(rnode, dict) else None
        if prnode is not None:
            # Usable node — keep it even if the response also carried a non-fatal
            # `errors` array (e.g. FORBIDDEN on individual statusCheckRollup
            # check-run nodes this token can't read, which surface as null
            # context nodes while leaving every PR-level field intact;
            # build_signature recovers CI counts from the Actions API there).
            out[target] = QueryResult(node=prnode)
        elif alias in gone_aliases:
            out[target] = QueryResult(gone=True)
        elif isinstance(rnode, dict) and "pullRequest" in rnode:
            # Repo resolved, pullRequest explicitly null, no NOT_FOUND error —
            # rare; treat as gone.
            out[target] = QueryResult(gone=True)
        else:
            # Alias null with no NOT_FOUND (rate limit, network, server error on
            # this subtree) — keep polling without changing known state.
            out[target] = QueryResult(transient_error=True)
    return out


def _count(items: list, predicate) -> int:
    return sum(1 for x in items if x and predicate(x))


def _fail_label(names: list[str], limit: int = 5) -> str:
    """Render failing-check names as a compact `FAIL[a,b,c]` token.

    Deduplicates (a workflow can surface as several rollup contexts), preserves
    order, and caps the list at `limit` with a `+N` overflow marker so the
    one-line-per-transition output stays bounded no matter how many checks
    fail. Returns "" when there are no usable names, in which case the caller
    omits the token and the bare `F=N` count still conveys the failure.
    """
    uniq = list(dict.fromkeys(n for n in names if n))
    if not uniq:
        return ""
    shown = uniq[:limit]
    body = ",".join(shown)
    extra = len(uniq) - len(shown)
    if extra > 0:
        body += f",+{extra}"
    return f"FAIL[{body}]"


def actions_check_counts(owner: str, name: str,
                         sha: str) -> tuple[int, int, int, list[str]]:
    """Best-effort (passed, failed, pending, fail_names) from the Actions API.

    Fallback for when statusCheckRollup returns null context nodes — i.e. the
    token can't read some check-runs (app-authored checks). The Actions API
    (/actions/runs) reports workflow run conclusions and stays readable with
    only Actions:read, even when the unified check-runs view is forbidden.

    Pages through all workflow runs for the SHA (newest-first) and keeps the
    latest run per workflow, so a commit with many reruns isn't truncated at the
    first 100 runs. Collects the names of the failing workflows so the caller can
    surface them inline. Only covers GitHub Actions workflow runs — legacy commit
    statuses and other apps' checks aren't represented, which is acceptable for
    this fallback. Returns (0, 0, 0, []) on any error so the caller degrades
    gracefully.
    """
    latest: dict[str, tuple[str, str]] = {}
    page = 1
    # Cap at 10 pages (1000 runs) — far more than any real commit accumulates.
    while page <= 10:
        p = run([
            "gh", "api",
            f"repos/{owner}/{name}/actions/runs"
            f"?head_sha={sha}&per_page=100&page={page}",
            "-q", '.workflow_runs[] | "\\(.name)\\t\\(.status)\\t\\(.conclusion // "")"',
        ])
        if p.returncode != 0:
            # A failure mid-pagination still yields what earlier pages collected.
            break
        lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
        for line in lines:
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            workflow, status, conclusion = parts
            # Newest-first ordering (across pages and within a page) means the
            # first row seen per workflow is the latest run.
            latest.setdefault(workflow, (status, conclusion))
        if len(lines) < 100:
            break
        page += 1

    passed = failed = pending = 0
    fail_names: list[str] = []
    for workflow, (status, conclusion) in latest.items():
        if status != "completed":
            pending += 1
        elif conclusion == "success":
            passed += 1
        elif conclusion in ("failure", "timed_out", "startup_failure"):
            failed += 1
            fail_names.append(workflow)
        elif conclusion == "action_required":
            # A workflow gated on manual approval (e.g. first-time-contributor
            # approval) hasn't concluded — count it as pending so it doesn't let
            # a premature READY slip through.
            pending += 1
        # neutral / skipped / cancelled / stale → neither pass nor fail,
        # mirroring how the rollup ignores SKIPPED/NEUTRAL contexts.
    return (passed, failed, pending, fail_names)


def _check_name(c: dict) -> str:
    # CheckRun has `name`; legacy StatusContext has `context`.
    return c.get("name") or c.get("context") or ""


def _classify_check(c: dict) -> str:
    """Classify a rollup context as 'pass' | 'fail' | 'pending' | 'ignore'.

    Handles both CheckRun (status + conclusion) and legacy StatusContext
    (state). ACTION_REQUIRED and STARTUP_FAILURE are treated meaningfully
    (pending / fail respectively) so they can't masquerade as "ignore" and
    let a premature READY through.
    """
    if not c:
        return "ignore"
    status = (c.get("status") or "").upper()
    conclusion = (c.get("conclusion") or "").upper()
    state = (c.get("state") or "").upper()
    if status:  # CheckRun
        if status != "COMPLETED":
            # QUEUED / IN_PROGRESS / WAITING / PENDING / REQUESTED
            return "pending"
        if conclusion == "SUCCESS":
            return "pass"
        if conclusion in ("FAILURE", "TIMED_OUT", "STARTUP_FAILURE"):
            return "fail"
        if conclusion == "ACTION_REQUIRED":
            return "pending"
        return "ignore"  # NEUTRAL / SKIPPED / CANCELLED / STALE
    # StatusContext
    if state == "SUCCESS":
        return "pass"
    if state in ("FAILURE", "ERROR"):
        return "fail"
    if state in ("PENDING", "EXPECTED"):
        return "pending"
    return "ignore"


class Signature:
    """Structured result of evaluating a PR's current state.

    `text` is the one-line signature shown to the user. `ready`/`is_draft` are
    carried explicitly so the caller doesn't have to re-parse `text` (READY used
    to be detected with a brittle endswith check, and draft transitions need a
    real boolean to diff against the previous poll). `is_draft` is None when the
    state doesn't carry draft info (terminal/transient).
    """

    __slots__ = ("text", "terminal", "should_emit", "ready", "is_draft")

    def __init__(self, text="", terminal=False, should_emit=False,
                 ready=False, is_draft=None):
        self.text = text
        self.terminal = terminal
        self.should_emit = should_emit
        self.ready = ready
        self.is_draft = is_draft


def build_signature(result: QueryResult, owner: str, name: str) -> Signature:
    """Turn a QueryResult into a Signature.

    `owner`/`name` are needed only for the Actions-API fallback when the token
    can't read some check-runs. On transient API errors, returns a non-emitting,
    non-terminal Signature so the caller skips the emit, leaves previous state
    unchanged, and keeps polling — a one-off blip never masquerades as a
    transition or falsely declares every watched PR terminal at once.
    """
    if result.transient_error:
        return Signature(should_emit=False, terminal=False)
    if result.gone:
        return Signature("GONE", terminal=True, should_emit=True, ready=True)
    node = result.node

    state = node.get("state") or "UNKNOWN"
    if state == "MERGED":
        # Branch was merged — nudge the agent to refresh the base branch and
        # drop the now-stale local feature branch. Branch names come from the
        # GitHub API; shlex.quote() them so a ref containing shell-significant
        # characters can't produce a broken or unsafe copy-pasteable command.
        # The agent decides whether the local branch actually exists first.
        base = node.get("baseRefName")
        head = node.get("headRefName")
        if base and head:
            cmd = (f"git checkout {shlex.quote(base)} && git pull --prune "
                   f"&& git branch -d {shlex.quote(head)}")
            text = (f"MERGED — pull latest {base} and prune local branch "
                    f"{head} ({cmd})")
        else:
            # Missing branch name(s): prose-only guidance, no broken command.
            text = ("MERGED — pull the latest default branch and prune the "
                    "local feature branch")
        return Signature(text, terminal=True, should_emit=True, ready=True)
    if state == "CLOSED":
        return Signature("CLOSED", terminal=True, should_emit=True, ready=True)

    # Pull check contexts off the latest commit; default to empty when missing.
    commits = (node.get("commits") or {}).get("nodes") or []
    contexts: list[dict] = []
    head_oid = None
    truncated = False
    if commits:
        commit = (commits[0] or {}).get("commit") or {}
        head_oid = commit.get("oid")
        rollup = commit.get("statusCheckRollup") or {}
        ctx_conn = rollup.get("contexts") or {}
        contexts = ctx_conn.get("nodes") or []
        truncated = bool((ctx_conn.get("pageInfo") or {}).get("hasNextPage"))

    # Null context nodes mean the token couldn't read those check-runs
    # (app-authored checks) — the rollup counts would silently undercount. Fall
    # back to the Actions API for an authoritative GitHub Actions view instead.
    # The fallback returns failing workflow names too, so failing-check names
    # are surfaced on both the GraphQL and Actions-API paths.
    if any(c is None for c in contexts) and head_oid:
        passed, failed, pending, fail_names = actions_check_counts(owner, name, head_oid)
        # The Actions API enumerates all runs for the SHA — no 100-context cap —
        # so its counts aren't subject to the rollup truncation flag.
        truncated = False
    else:
        passed = failed = pending = 0
        fail_names = []
        for c in contexts:
            kind = _classify_check(c)
            if kind == "pass":
                passed += 1
            elif kind == "fail":
                failed += 1
                fail_names.append(_check_name(c))
            elif kind == "pending":
                pending += 1

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

    # A PR converted back to draft is a deliberate "pause review" signal — most
    # often our claude-pr-review reusable's `draft_on_blocking`, which flips the
    # PR to draft when a review posts blocking comments so re-reviews don't fire
    # until the author resolves them and marks it ready again. mergeState is
    # DRAFT while drafted (so READY is already suppressed below); we surface an
    # explicit token and, when the timeline knows it, who did the conversion.
    is_draft = bool(node.get("isDraft"))
    draft_actor = ""
    if is_draft:
        draft_events = (node.get("timelineItems") or {}).get("nodes") or []
        if draft_events:
            draft_actor = ((draft_events[-1] or {}).get("actor") or {}).get("login") or ""

    parts = [f"P={passed}", f"F={failed}", f"W={pending}"]
    # Inline the failing-check names on a failure so the agent doesn't have to
    # run `gh pr checks` for the most common follow-up question. Only on F>0,
    # so passing/pending transitions stay as terse as before.
    if failed > 0:
        flabel = _fail_label(fail_names)
        if flabel:
            parts.append(flabel)
    if truncated:
        # >100 checks on the head commit: the counts above cover only the first
        # page, so flag that they may be incomplete rather than undercount
        # silently. The merge_state gate below still governs READY honestly.
        parts.append("TRUNC")
    if mergeable == "CONFLICTING":
        parts.append("CONFLICT")
    if changes_requested > 0:
        parts.append("CR")
    if unresolved > 0:
        parts.append(f"U={unresolved}")
    if review_requests > 0:
        parts.append(f"RR={review_requests}")
    if is_draft:
        parts.append(f"DRAFT(by {draft_actor})" if draft_actor else "DRAFT")
    # Surface a generic block (a required review/ruleset/check or a blocking
    # comment) that the counts above didn't already explain. Draft is reported
    # separately above, so don't double-flag it as a generic BLOCKED.
    elif merge_state == "BLOCKED" and not (changes_requested or unresolved or review_requests):
        parts.append("BLOCKED")

    # READY requires both: our tracked signals are clear AND GitHub
    # affirmatively reports the PR as mergeable with a non-blocked merge state.
    # Requiring mergeable == "MERGEABLE" (not merely != "CONFLICTING") and
    # excluding the UNKNOWN merge state closes the race right after a push where
    # GitHub hasn't computed mergeability yet — without it, a fresh PR with no
    # checks registered would flash a misleading READY before the checks appear.
    ready = (pending == 0 and failed == 0 and review_requests == 0
             and changes_requested == 0 and unresolved == 0
             and not truncated
             and mergeable == "MERGEABLE"
             and merge_state not in ("BLOCKED", "DIRTY", "BEHIND", "DRAFT", "UNKNOWN"))
    if ready:
        parts.append("READY")

    return Signature(",".join(parts), terminal=False, should_emit=True,
                     ready=ready, is_draft=is_draft)


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


def next_delay(poll: int, max_streak: int, all_ready: bool) -> int:
    """Pick the inter-poll sleep.

    Error backoff takes precedence: once any PR has hit ERROR_BACKOFF_THRESHOLD
    consecutive errors, sleep grows exponentially (capped) so a rate-limit or
    outage isn't hammered. Otherwise, slow to 2x once everything is READY (just
    waiting on a human to merge), or poll normally.
    """
    if max_streak >= ERROR_BACKOFF_THRESHOLD:
        factor = 2 ** (max_streak - ERROR_BACKOFF_THRESHOLD + 1)
        return min(poll * factor, ERROR_BACKOFF_MAX_SECONDS)
    if all_ready:
        return poll * 2
    return poll


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
    ready_state: "dict[tuple[str, int], bool]" = {}
    prev_draft: "dict[tuple[str, int], bool]" = {}
    err_streak: "dict[tuple[str, int], int]" = {}
    warned: "set[tuple[str, int]]" = set()

    while True:
        # Batch the round's queries: one aliased GraphQL request per chunk
        # instead of one request per PR.
        results: "dict[tuple[str, int], QueryResult]" = {}
        for start in range(0, len(targets), BATCH_CHUNK):
            results.update(query_batch(targets[start:start + BATCH_CHUNK]))

        all_terminal = True
        for repo, pr in targets:
            key = (repo, pr)
            owner, name = repo.split("/", 1)
            res = results.get(key) or QueryResult(transient_error=True)
            sig = build_signature(res, owner, name)

            if not sig.terminal:
                all_terminal = False

            if not sig.should_emit:
                # Transient error: count the streak and surface a one-time WARN
                # so sustained unreadability isn't silently swallowed. Leave
                # previous/ready_state/prev_draft unchanged.
                err_streak[key] = err_streak.get(key, 0) + 1
                if err_streak[key] == ERROR_WARN_THRESHOLD and key not in warned:
                    emit(f"{label(repo, pr)}: WARN unreadable after "
                         f"{err_streak[key]} consecutive API errors; still retrying")
                    warned.add(key)
                continue

            # Successful read (live or terminal): reset error tracking.
            err_streak[key] = 0
            warned.discard(key)
            ready_state[key] = bool(sig.ready)

            # Detect a draft <-> ready-for-review flip so the transition reads
            # explicitly rather than as a bare DRAFT-token appearance/removal.
            transition: list[str] = []
            if sig.is_draft is not None:
                if key in prev_draft and prev_draft[key] != sig.is_draft:
                    transition.append("DRAFTED" if sig.is_draft else "UNDRAFTED")
                prev_draft[key] = sig.is_draft

            if key not in previous or sig.text != previous[key]:
                text = sig.text
                if transition:
                    text = ",".join(transition + ([text] if text else []))
                emit(f"{label(repo, pr)}: {text}")
                # Store the raw signature (without the ephemeral transition
                # token) so dedup compares like-for-like next round.
                previous[key] = sig.text
            elif transition:
                # State is otherwise unchanged but the draft flag flipped — emit
                # so the draft transition is never missed (e.g. a re-draft that
                # doesn't change any other signal).
                emit(f"{label(repo, pr)}: {','.join(transition + [sig.text])}")

        if all_terminal:
            emit("ci-watch: all watched PRs reached a terminal state")
            return 0

        max_streak = max(err_streak.values(), default=0)
        all_ready = bool(ready_state) and all(ready_state.values())
        time.sleep(next_delay(poll, max_streak, all_ready))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
