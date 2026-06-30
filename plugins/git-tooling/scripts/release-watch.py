#!/usr/bin/env python3
"""release-watch.py — Watch a release through to publication.

The sibling of ci-watch.py: where ci-watch ends (at MERGED), release-watch
begins. After a merge to the default branch, the release workflow fires and
publishes a git tag + GitHub Release and, for many repos, a new container
image to GHCR. This watcher follows that release through to publication.

It covers BOTH halves of a release:

  (a) GitHub repo releases — the release workflow run (release.yml /
      auto-release.yml, or any workflow whose name contains "release"), the
      git tag, and the GitHub Release object appearing.
  (b) GHCR container packages — a NEW image version (a new tag, or a moving
      tag like `latest` repointed to a new digest) appearing at
      ghcr.io/<owner>/<pkg> (incl. nested names like charts/hermes).

Emits one stdout line per state transition (each becomes a Monitor
notification). Exits 0 when every watched target reaches a terminal state
(release published / package version appeared / workflow concluded). Exits 1
if any target reached a FAILURE terminal (release workflow failed/cancelled,
or a package was permanently inaccessible) — so silence is never confused
with "still running" and a failure is detectable by exit code too.

Usage:
    # Repo release: most-recent release workflow run + newest release tag.
    release-watch.py owner/repo

    # Wait for a SPECIFIC release tag to publish (exits at once if already up).
    release-watch.py owner/repo --tag vX.Y.Z

    # GHCR package: wait for a NEW image version vs the baseline at start.
    release-watch.py --ghcr owner/pkg
    release-watch.py --ghcr owner/charts/hermes      # nested package name

    # Wait for a SPECIFIC package tag.
    release-watch.py --ghcr owner/pkg --tag vX.Y.Z

    # Mix freely — one Monitor call covers the whole release:
    release-watch.py owner/svc --ghcr owner/svc
    release-watch.py owner/a owner/b --ghcr owner/charts/c --tag v1.2.0

`--tag T` binds to the immediately preceding target (repo or --ghcr).

Env:
    GIT_TOOLING_RELEASE_POLL_SECONDS        poll interval in seconds (default 30)
    GIT_TOOLING_RELEASE_GHCR_GRACE_SECONDS  how long a GHCR package may stay
                                            HTTP-404 before the target is
                                            declared INACCESSIBLE (default 600).
                                            A first-ever publish 404s until the
                                            release run pushes the image, so a
                                            404 is treated as "not published
                                            yet (waiting)" until this window
                                            elapses. 0 disables the grace (404
                                            is terminal at once).

Requires: python3 (3.8+), gh (authenticated). GHCR reads use only the Python
standard library (urllib) — no Docker/pip needed. Public GHCR packages read
anonymously; private packages need the gh token to carry the `read:packages`
scope. A private/unscoped package returns 401/403 (an unambiguous scope denial)
and fails the target gracefully at once; a 404 (not-yet-published OR private)
is polled through the grace window above, then fails — it never crashes the
watch. Portable across macOS and Linux.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

# Workflow-file basenames we treat as "the release workflow". Anything else is
# matched by a case-insensitive "release" in the workflow's display name as a
# fallback (covers repos that name the file differently).
RELEASE_WORKFLOW_BASENAMES = {"release.yml", "release.yaml",
                              "auto-release.yml", "auto-release.yaml"}

# Concluded workflow-run conclusions that mean the release did NOT publish.
BAD_CONCLUSIONS = {"failure", "timed_out", "startup_failure", "cancelled"}

# How many consecutive "nothing in flight" polls to tolerate before declaring a
# no-`--tag` repo target terminal. Bridges the few-second gap between a merge
# and the release run registering in the Actions API, so a just-merged release
# isn't declared "no new release" prematurely.
IDLE_GRACE_POLLS = 2

GHCR_HTTP_TIMEOUT = 15

# How long a GHCR target may stay continuously HTTP-404 before we give up and
# declare it INACCESSIBLE. Bridges the gap between a watch starting and a first-
# ever package publish (the release run builds/pushes the image minutes later),
# while still failing a genuinely-private/never-appearing package eventually
# instead of polling until the Monitor's overall timeout. Overridable via
# GIT_TOOLING_RELEASE_GHCR_GRACE_SECONDS (set in main from the environment).
GHCR_GRACE_SECONDS = 600


def die(msg: str, code: int = 1) -> None:
    print(f"release-watch: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def emit(line: str) -> None:
    print(line, flush=True)


def run(argv: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 1, "", "timeout")
    except FileNotFoundError:
        return subprocess.CompletedProcess(argv, 127, "", f"{argv[0]}: not found")


def gh_json(path: str):
    """`gh api <path>` parsed as JSON, or None on any failure (incl. 404).

    A None return is deliberately ambiguous between "not found" and a transient
    error — callers that must not act on transient blips require positive
    evidence (a parsed field) before declaring a terminal state.
    """
    p = run(["gh", "api", path])
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout) if p.stdout.strip() else None
    except json.JSONDecodeError:
        return None


def detect_repo() -> Optional[str]:
    p = run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    repo = p.stdout.strip()
    return repo if (p.returncode == 0 and repo) else None


# ── target model ─────────────────────────────────────────────────────────

class Target:
    """A single thing to watch: a repo release or a GHCR package.

    kind   : "repo" or "ghcr"
    owner  : GitHub user/org
    name   : repo name (repo) or package path, may contain '/' (ghcr)
    tag    : optional specific tag to wait for
    """

    __slots__ = ("kind", "owner", "name", "tag", "baseline", "state", "_idle",
                 "_first_404")

    def __init__(self, kind: str, owner: str, name: str):
        self.kind = kind
        self.owner = owner
        self.name = name
        self.tag: Optional[str] = None
        self.baseline = None          # kind-specific baseline captured at start
        self.state = ""               # last emitted signature
        self._idle = 0                # idle-poll counter (repo, no --tag)
        self._first_404: Optional[float] = None  # monotonic time of first GHCR 404

    @property
    def repo(self) -> str:
        return f"{self.owner}/{self.name}"

    def label(self, multi: bool) -> str:
        # Single target: keep it terse (the familiar bare name). Multiple:
        # fully qualify so same-named repo/package targets stay distinct.
        if not multi:
            return self.name
        return f"ghcr:{self.repo}" if self.kind == "ghcr" else self.repo


# ── GHCR reads (stdlib only) ─────────────────────────────────────────────

class Snapshot:
    __slots__ = ("tags", "ref_digest", "err", "permanent", "not_found", "source")

    def __init__(self, tags=None, ref_digest=None, err=None,
                 permanent=False, not_found=False, source=""):
        self.tags = tags if tags is not None else set()
        self.ref_digest = ref_digest
        self.err = err
        self.permanent = permanent
        # 404 from GHCR is ambiguous: package-not-published-yet (first publish)
        # vs private-and-unreadable. Flagged separately so the caller can apply
        # a poll-through grace window instead of failing immediately.
        self.not_found = not_found
        self.source = source


def _http(url: str, headers: dict, method: str = "GET"):
    """Return (status, body_bytes, resp_headers). Raises urllib URLError on a
    network-level failure (caller treats that as transient)."""
    def lower_headers(raw) -> dict:
        # HTTP header names are case-insensitive (RFC 9110); normalize to
        # lowercase keys so callers can look them up deterministically.
        return {k.lower(): v for k, v in dict(raw or {}).items()}

    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=GHCR_HTTP_TIMEOUT) as resp:
            return resp.status, resp.read(), lower_headers(resp.headers)
    except urllib.error.HTTPError as e:
        # HTTP errors (401/403/404/...) carry a status and body — return them
        # so the caller can classify permanent vs transient.
        return e.code, e.read(), lower_headers(e.headers)


def gh_token() -> Optional[str]:
    p = run(["gh", "auth", "token"])
    tok = p.stdout.strip()
    return tok if (p.returncode == 0 and tok) else None


def registry_token(repo: str, authed_tok: Optional[str]) -> Optional[str]:
    """Fetch a ghcr.io pull token for `repo`. Anonymous unless authed_tok is
    given (Basic auth, for private packages). None on unauthorized/failure."""
    url = f"https://ghcr.io/token?service=ghcr.io&scope=repository:{repo}:pull"
    headers = {"Accept": "application/json"}
    if authed_tok:
        # ghcr ignores the username for token grants (the PAT is what matters),
        # but Basic auth still needs a non-empty user field — use `_`, never a
        # hardcoded login, so this works for any user's token.
        basic = base64.b64encode(f"_:{authed_tok}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    status, body, _ = _http(url, headers)
    if status != 200:
        return None
    try:
        return (json.loads(body) or {}).get("token")
    except json.JSONDecodeError:
        return None


def registry_tags(repo: str, token: str):
    """Return (tags_set, err, permanent, not_found). tags_set is None on error.

    `not_found` flags an HTTP 404 specifically — ambiguous between "package not
    published yet" and "private package hidden from this token" — so the caller
    can poll through a grace window rather than failing immediately. 401/403 is
    an unambiguous scope denial and stays terminal (permanent=True).
    """
    url = f"https://ghcr.io/v2/{repo}/tags/list?n=1000"
    status, body, _ = _http(url, {"Authorization": f"Bearer {token}",
                                  "Accept": "application/json"})
    if status == 200:
        try:
            return set((json.loads(body) or {}).get("tags") or []), None, False, False
        except json.JSONDecodeError:
            return None, "malformed tags response", False, False
    if status in (401, 403):
        return (None,
                "registry denied (token lacks read:packages scope for this "
                "private package)", True, False)
    if status == 404:
        # Only *conditionally* terminal: the consumer polls through a grace
        # window (driven by not_found) before giving up, so permanent=False —
        # don't rely on caller check-ordering to keep the grace logic alive.
        return None, "package not found", False, True
    return None, f"registry HTTP {status}", False, False


def registry_digest(repo: str, token: str, tag: str) -> Optional[str]:
    """The manifest digest a tag points at (to detect moving-tag republishes).
    Best-effort: None if the HEAD doesn't yield a digest."""
    # URL-encode the tag (safe='') so tags with reserved characters — e.g. a
    # SemVer build-metadata tag like v1.0.0+build.123 — can't corrupt the URL.
    url = f"https://ghcr.io/v2/{repo}/manifests/{urllib.parse.quote(tag, safe='')}"
    accept = ("application/vnd.oci.image.index.v1+json,"
              "application/vnd.oci.image.manifest.v1+json,"
              "application/vnd.docker.distribution.manifest.list.v2+json,"
              "application/vnd.docker.distribution.manifest.v2+json")
    try:
        _, _, hdrs = _http(url, {"Authorization": f"Bearer {token}",
                                 "Accept": accept}, method="HEAD")
    except urllib.error.URLError:
        return None
    return hdrs.get("docker-content-digest")


def ghcr_rest_versions(owner: str, pkg: str):
    """GitHub REST package versions, or None if unavailable. Authoritative
    (newest-first, rich metadata) when the token has read:packages — otherwise
    falls back to the OCI registry path."""
    enc = pkg.replace("/", "%2F")
    p = run(["gh", "api",
             f"/users/{owner}/packages/container/{enc}/versions?per_page=100"])
    if p.returncode != 0:
        return None
    try:
        data = json.loads(p.stdout)
        return data if isinstance(data, list) else None
    except json.JSONDecodeError:
        return None


def ghcr_snapshot(owner: str, pkg: str, ref_tag: str) -> Snapshot:
    """Current tags + the digest behind `ref_tag` for a GHCR package.

    Tries the GitHub REST packages API first (works for public + private when
    the token carries read:packages), then the OCI registry (anonymous for
    public packages, Basic-auth for private). Permanent errors (private +
    unscoped token, package not found) are flagged so the caller can fail that
    target gracefully without aborting the whole watch.
    """
    repo = f"{owner}/{pkg}"

    versions = ghcr_rest_versions(owner, pkg)
    if versions is not None:
        tags: set[str] = set()
        ref_digest = None
        for v in versions:
            vtags = (((v or {}).get("metadata") or {}).get("container") or {}).get("tags") or []
            for t in vtags:
                tags.add(t)
            if ref_tag in vtags:
                ref_digest = v.get("name")  # the sha256:... digest
        return Snapshot(tags=tags, ref_digest=ref_digest, source="rest")

    # Registry path. Anonymous first (clean for public packages); only escalate
    # to Basic auth when anonymous is refused, since a scope-deficient token
    # would otherwise turn a readable public package into a DENIED.
    try:
        token = registry_token(repo, authed_tok=None)
        used_auth = False
        if token is None:
            tok = gh_token()
            if tok:
                token = registry_token(repo, authed_tok=tok)
                used_auth = True
        if token is None:
            return Snapshot(err="anonymous pull unauthorized — package is "
                                "private and the gh token can't read it "
                                "(needs read:packages scope)",
                            permanent=True)
        tags, err, permanent, not_found = registry_tags(repo, token)
        if tags is None:
            return Snapshot(err=err, permanent=permanent, not_found=not_found)
        ref_digest = registry_digest(repo, token, ref_tag) if ref_tag in tags else None
        return Snapshot(tags=tags, ref_digest=ref_digest,
                        source="registry/auth" if used_auth else "registry")
    except urllib.error.URLError as e:
        return Snapshot(err=f"network error reaching ghcr.io ({e.reason})",
                        permanent=False)


def build_ghcr_signature(t: Target) -> tuple[str, bool, bool, bool]:
    """(signature, terminal, should_emit, is_failure) for a GHCR target."""
    ref_tag = t.tag or "latest"
    snap = ghcr_snapshot(t.owner, t.name, ref_tag)

    if snap.err:
        if snap.not_found:
            # A 404 is ambiguous: (a) the package isn't published yet — common
            # on a first-ever publish, where the release run creates it minutes
            # later — or (b) it's private and this token can't see it (GHCR 404s
            # rather than 403 to avoid leaking existence). Poll through it: keep
            # the target alive so a first publish is caught, but start a grace
            # clock so a genuinely-private/never-appearing package still fails
            # instead of polling until the Monitor's overall timeout.
            now = time.monotonic()
            if t._first_404 is None:
                t._first_404 = now
            if now - t._first_404 >= GHCR_GRACE_SECONDS:
                return (f"INACCESSIBLE — {snap.err}", True, True, True)
            return (f"{t.repo}: not published yet (waiting)", False, True, False)
        if snap.permanent:
            return (f"INACCESSIBLE — {snap.err}", True, True, True)
        return ("", False, False, False)  # transient: keep polling, don't emit

    # Package is readable again — reset the 404 grace clock.
    t._first_404 = None

    base: Snapshot = t.baseline

    if t.tag:
        if t.tag in snap.tags:
            return (f"PUBLISHED {t.repo}:{t.tag}", True, True, False)
        return (f"waiting {t.repo}:{t.tag} ({len(snap.tags)} tags)", False, True, False)

    # No specific tag: any new tag, or the reference tag repointed to a new
    # digest (covers moving-`latest` republishes like discord-ops).
    new_tags = sorted(snap.tags - (base.tags if base else set()))
    if new_tags:
        shown = ",".join(new_tags[:5]) + (f",+{len(new_tags) - 5}" if len(new_tags) > 5 else "")
        return (f"PUBLISHED {t.repo} new tag(s): {shown}", True, True, False)
    if (base and base.ref_digest and snap.ref_digest
            and snap.ref_digest != base.ref_digest):
        return (f"PUBLISHED {t.repo}:{ref_tag} repointed -> "
                f"{snap.ref_digest[:19]}", True, True, False)
    return (f"{t.repo}: {len(snap.tags)} tags, no new version", False, True, False)


# ── GitHub repo-release reads ────────────────────────────────────────────

def latest_release_tag(owner: str, name: str) -> Optional[str]:
    data = gh_json(f"repos/{owner}/{name}/releases/latest")
    return (data or {}).get("tag_name")


def tag_published(owner: str, name: str, tag: str) -> bool:
    p = run(["gh", "api", f"repos/{owner}/{name}/releases/tags/{tag}",
             "-q", ".tag_name"])
    return p.returncode == 0 and p.stdout.strip() != ""


def newest_release_run(owner: str, name: str) -> Optional[dict]:
    """The most recent run of the repo's release workflow, or None.

    The Actions runs API returns newest-first; we pick the first run whose
    workflow-file basename is a known release filename, falling back to a
    case-insensitive "release" in the workflow's display name.
    """
    data = gh_json(f"repos/{owner}/{name}/actions/runs?per_page=30")
    runs = (data or {}).get("workflow_runs") or []

    def is_release(r: dict) -> bool:
        path = (r.get("path") or "")
        base = path.rsplit("/", 1)[-1].lower()
        if base in RELEASE_WORKFLOW_BASENAMES:
            return True
        return "release" in (r.get("name") or "").lower()

    for r in runs:
        if is_release(r):
            return r
    return None


def _run_state(run_obj: Optional[dict]) -> str:
    if not run_obj:
        return "none"
    status = run_obj.get("status") or "unknown"
    concl = run_obj.get("conclusion")
    return f"{status}/{concl}" if concl else status


def build_repo_signature(t: Target) -> tuple[str, bool, bool, bool]:
    """(signature, terminal, should_emit, is_failure) for a repo target."""
    run_obj = newest_release_run(t.owner, t.name)
    latest = latest_release_tag(t.owner, t.name)
    baseline_tag, baseline_run_id, baseline_completed = t.baseline

    # ── specific-tag mode ────────────────────────────────────────────────
    if t.tag:
        if tag_published(t.owner, t.name, t.tag):
            return (f"RELEASED {t.tag} ({_run_state(run_obj)})", True, True, False)
        # The release run that would cut this tag failed → surface + terminate
        # (it isn't coming). Only when the failing run started during our watch
        # (a new run id) so a stale prior failure doesn't false-terminate.
        if run_obj and run_obj.get("status") == "completed":
            concl = run_obj.get("conclusion")
            new_run = run_obj.get("id") != baseline_run_id
            if concl in BAD_CONCLUSIONS and new_run:
                return (f"RUN {concl} — {t.tag} not published "
                        f"({run_obj.get('html_url', '')})", True, True, True)
        return (f"RUN={_run_state(run_obj)},waiting tag {t.tag}", False, True, False)

    # ── newest-release mode ──────────────────────────────────────────────
    # A change to releases/latest vs the baseline means a fresh publish.
    if latest is not None and latest != baseline_tag:
        return (f"RELEASED {latest} ({_run_state(run_obj)})", True, True, False)

    run_id = run_obj.get("id") if run_obj else None
    status = run_obj.get("status") if run_obj else None
    # An "active" run is one that fired during this watch, or was still running
    # when we started. A stale, already-completed baseline run is NOT active —
    # treat that as the idle case so we don't terminate on history.
    active = bool(run_obj) and (run_id != baseline_run_id or not baseline_completed)

    if active and status == "completed":
        concl = run_obj.get("conclusion")
        if concl == "success":
            return (f"RUN success — no new release (latest {latest or 'none'})",
                    True, True, False)
        if concl in BAD_CONCLUSIONS:
            return (f"RUN {concl} — release workflow failed "
                    f"({run_obj.get('html_url', '')})", True, True, True)
        return (f"RUN {concl}", True, True, False)  # neutral/skipped

    if not active:
        # Nothing in flight. Tolerate a couple of polls for a just-merged
        # release run to register, then exit cleanly if the repo is truly idle.
        t._idle += 1
        if t._idle >= IDLE_GRACE_POLLS:
            return (f"idle — no release in flight (latest {latest or 'none'})",
                    True, True, False)
        return (f"RUN=none,latest {latest or 'none'} (waiting)", False, True, False)

    t._idle = 0
    return (f"RUN={_run_state(run_obj)},latest {latest or 'none'}", False, True, False)


# ── argument parsing ─────────────────────────────────────────────────────

def parse_args(argv: list[str]) -> list[Target]:
    targets: list[Target] = []
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--ghcr":
            if i + 1 >= len(argv):
                die("missing package for --ghcr")
            spec = argv[i + 1]
            if "/" not in spec:
                die(f"invalid --ghcr package {spec!r}; expected owner/pkg")
            owner, name = spec.split("/", 1)
            if not owner or not name:
                die(f"invalid --ghcr package {spec!r}; expected owner/pkg")
            targets.append(Target("ghcr", owner, name))
            i += 2
            continue
        if tok == "--tag":
            if i + 1 >= len(argv):
                die("missing value for --tag")
            if not targets:
                die("--tag must follow a target (owner/repo or --ghcr owner/pkg)")
            targets[-1].tag = argv[i + 1]
            i += 2
            continue
        if tok.startswith("-"):
            die(f"unknown flag {tok!r}")
        # Bare token → a repo target. Must be exactly owner/repo.
        parts = tok.split("/")
        if len(parts) != 2 or not all(parts):
            die(f"invalid repo {tok!r}; expected owner/repo "
                f"(use --ghcr for packages)")
        targets.append(Target("repo", parts[0], parts[1]))
        i += 1
    return targets


def parse_poll_interval() -> int:
    raw = os.environ.get("GIT_TOOLING_RELEASE_POLL_SECONDS", "30").strip()
    if not raw:
        return 30
    try:
        value = int(raw)
    except ValueError:
        die(f"GIT_TOOLING_RELEASE_POLL_SECONDS={raw!r} is not an integer")
    if value < 1:
        die(f"GIT_TOOLING_RELEASE_POLL_SECONDS={raw!r} must be >= 1")
    return value


def parse_ghcr_grace() -> int:
    raw = os.environ.get("GIT_TOOLING_RELEASE_GHCR_GRACE_SECONDS", "").strip()
    if not raw:
        return GHCR_GRACE_SECONDS
    try:
        value = int(raw)
    except ValueError:
        die(f"GIT_TOOLING_RELEASE_GHCR_GRACE_SECONDS={raw!r} is not an integer")
    if value < 0:
        die(f"GIT_TOOLING_RELEASE_GHCR_GRACE_SECONDS={raw!r} must be >= 0")
    return value


# ── baseline capture ─────────────────────────────────────────────────────

def init_baseline(t: Target) -> None:
    if t.kind == "ghcr":
        t.baseline = ghcr_snapshot(t.owner, t.name, t.tag or "latest")
        return
    # repo: (latest release tag, newest release-run id, whether it's completed)
    latest = latest_release_tag(t.owner, t.name)
    run_obj = newest_release_run(t.owner, t.name)
    run_id = run_obj.get("id") if run_obj else None
    completed = bool(run_obj) and run_obj.get("status") == "completed"
    t.baseline = (latest, run_id, completed)


# ── main loop ────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    global GHCR_GRACE_SECONDS
    poll = parse_poll_interval()
    GHCR_GRACE_SECONDS = parse_ghcr_grace()

    if not shutil.which("gh"):
        die("gh not found")
    if run(["gh", "auth", "status"]).returncode != 0:
        die("gh not authenticated")

    targets = parse_args(argv)
    if not targets:
        die("no targets — pass owner/repo and/or --ghcr owner/pkg "
            "(see --help in the docstring)")

    multi = len(targets) > 1
    for t in targets:
        init_baseline(t)

    descr = ", ".join(t.label(multi) for t in targets)
    emit(f"release-watch: watching {len(targets)} target(s): {descr} "
         f"(poll every {poll}s)")

    terminal: dict[int, bool] = {}
    had_failure = False
    builders = {"repo": build_repo_signature, "ghcr": build_ghcr_signature}

    while True:
        all_terminal = True
        for idx, t in enumerate(targets):
            if terminal.get(idx):
                continue
            sig, is_terminal, should_emit, is_failure = builders[t.kind](t)
            if not is_terminal:
                all_terminal = False
            if should_emit and sig != t.state:
                emit(f"{t.label(multi)}: {sig}")
                t.state = sig
            if is_terminal:
                terminal[idx] = True
                if is_failure:
                    had_failure = True

        if all_terminal:
            emit("release-watch: all targets reached a terminal state")
            return 1 if had_failure else 0

        time.sleep(poll)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
