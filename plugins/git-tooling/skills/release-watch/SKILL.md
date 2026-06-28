---
name: release-watch
description: This skill should be used proactively after a PR merges to the
  default branch (where ci-watch stops), and whenever the user asks to "watch
  the release", "did the release publish", "is the release out yet", "watch
  release.yml", "wait for the tag", "tell me when the GitHub Release is up",
  "watch for the new image", "did the container/chart push", "is the GHCR
  package updated", "wait for the new version on ghcr", or any request to follow
  a release through to publication without manual polling. Covers BOTH the
  GitHub repo release (release workflow run + git tag + GitHub Release) and GHCR
  container/chart package publishes (a new image version at ghcr.io). Works for
  one repo, one package, or many of each across owners in a single call.
  Invokes the Monitor tool with release-watch.py to stream publish/fail/pending
  transitions as notifications, stopping when every watched target is published
  or the release workflow concludes.
allowed-tools:
- Bash(python3:*)
- Bash(gh repo view:*)
- Bash(gh release list:*)
- Bash(gh release view:*)
- Bash(gh run list:*)
- Monitor
- TaskStop
example_prompts:
- watch the release for this repo
- did the release publish yet
- wait for tag v1.4.0 to publish
- tell me when the GitHub Release is up
- watch for the new ghcr image
- did the chart push to ghcr
- watch the release and the container build
permalink: tooling/claude-plugins/plugins/git-tooling/skills/release-watch/skill
---

# Release Watch

Watch a release through to publication without manually polling. This skill is the sibling of `ci-watch`: where ci-watch ends — at `MERGED` — release-watch begins. After a merge to the default branch, the release workflow fires and publishes a git tag + GitHub Release and, for many repos, a new container/chart image to GHCR. This skill invokes the `Monitor` tool with `release-watch.py`, which emits one notification per state transition and exits when every watched target reaches a terminal state.

It covers **both halves** of a release in one call:

- **GitHub repo release** — the release workflow run (`release.yml` / `auto-release.yml`, or any workflow whose name contains "release"), the git tag, and the GitHub Release object appearing.
- **GHCR package publish** — a new image version appearing at `ghcr.io/<owner>/<pkg>`: a new tag, or a moving tag like `latest` repointed to a new digest (so deploy-on-`latest` repos like discord-ops are covered too). Nested package names like `charts/hermes` work.

**Requirements:** `python3` (3.8+) and `gh` (authenticated). The script uses only the Python standard library (`urllib` for GHCR) — no `pip`/Docker needed. Works on macOS and Linux.

## When to run it

Run release-watch **after a PR merges** when that merge is expected to cut a release — i.e. it carries a `semver:*` label, or the repo releases on every push to main. It's the natural follow-on to ci-watch: ci-watch reports `MERGED`, then release-watch confirms the release actually published.

- **It's safe to start unconditionally.** The Monitor backgrounds itself and self-times-out, exiting the moment every watched target reaches a terminal state. It never blocks other work.
- **Watch the whole release.** If the release publishes both a GitHub Release **and** a GHCR image (the common case for a service repo), watch both in one Monitor call (`owner/repo --ghcr owner/pkg`) rather than starting two watchers.
- **The valid skip** is a merge that cuts no release (no `semver:*` label on an opt-in repo, a docs/chore-only change). If no release is expected, don't start a watcher.

## Current Repository State (Injected)

**Repository:**
```
!`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "(not in a github repo)"`
```

**Latest release:**
```
!`gh release list -L 3 2>/dev/null || echo "(no releases)"`
```

**Most recent release workflow run:**
```
!`gh run list --workflow release.yml -L 1 --json status,conclusion,headBranch,createdAt -q '.[] | "\(.status)/\(.conclusion // "—") on \(.headBranch) @ \(.createdAt)"' 2>/dev/null || echo "(no release.yml runs)"`
```

## How to Use

### Step 1 — Determine what to watch

| User intent | Target token |
|---|---|
| "watch the release for owner/repo" | `owner/repo` (most-recent release workflow run + newest release tag) |
| "wait for tag vX.Y.Z" | `owner/repo --tag vX.Y.Z` |
| "watch for the new ghcr image / chart" | `--ghcr owner/pkg` (new version vs the baseline at start) |
| "wait for image tag vX.Y.Z" | `--ghcr owner/pkg --tag vX.Y.Z` |
| Release publishes Release **and** image | `owner/repo --ghcr owner/pkg` (one watcher, both halves) |
| Several releases across repos/packages | mix freely: `owner/a owner/b --ghcr owner/charts/c` |

`--tag T` binds to the **immediately preceding** target (the repo or `--ghcr` package it follows). GHCR package names may be nested (`owner/charts/hermes`); a bare `owner/repo` (exactly two segments) is always a repo target — packages must use `--ghcr`.

### Step 2 — Invoke the Monitor tool

```
Monitor(
  description: "Release for owner/repo",
  command: "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/release-watch.py\" <targets>",
  persistent: false,
  timeout_ms: 1800000
)
```

**Always invoke via `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/release-watch.py"`** — do not call the script directly. This avoids depending on the executable bit surviving installation.

Argument forms (mix freely in one call):
- Repo release: `... release-watch.py owner/repo`
- Specific tag: `... release-watch.py owner/repo --tag v1.4.0`
- GHCR package: `... release-watch.py --ghcr owner/pkg`
- Both halves: `... release-watch.py owner/svc --ghcr owner/svc --tag v1.4.0`

### Step 3 — Pick `timeout_ms`

The script exits naturally when all targets reach a terminal state, so `timeout_ms` is just a safety cap. Releases usually publish within a few minutes of the workflow firing, but artifact builds (images, charts) can take longer.

| Scenario | `timeout_ms` | `persistent` |
|---|---|---|
| Repo release only (**default**) | `1800000` (30 min) | `false` |
| Release with image/chart build | `3600000` (60 min, max) | `false` |
| Unpredictable / "keep watching" | any | `true` |

If the Monitor times out before publication, tell the user and offer to re-invoke.

### Step 4 — Act on notifications

Each notification line is `<target>: <signature>`:

| Line | Meaning |
|---|---|
| `repo: RUN=in_progress,latest v1.3.0 (waiting)` | Release workflow running; newest published release is still v1.3.0 |
| `repo: RELEASED v1.4.0 (completed/success)` | New GitHub Release published — terminal (good) |
| `repo: RUN success — no new release (latest v1.3.0)` | Release workflow finished green but published nothing (e.g. no `semver:*` label) — terminal (neutral) |
| `repo: RUN failure — release workflow failed (<url>)` | Release workflow concluded failure/cancelled/timed_out — **terminal (failure)**, surface the URL |
| `repo: RUN failure — v1.4.0 not published (<url>)` | (`--tag` mode) the release run that would cut the tag failed — terminal (failure) |
| `repo: idle — no release in flight (latest v1.3.0)` | No release workflow run is in flight (nothing merged is releasing) — terminal (neutral) |
| `ghcr:owner/pkg: PUBLISHED owner/pkg:v1.4.0` | The requested image tag appeared — terminal (good) |
| `ghcr:owner/pkg: PUBLISHED owner/pkg new tag(s): v1.4.0` | A new image tag appeared vs baseline — terminal (good) |
| `ghcr:owner/pkg: PUBLISHED owner/pkg:latest repointed -> sha256:abc…` | A moving tag (`latest`) now points at a new digest — terminal (good) |
| `ghcr:owner/pkg: owner/pkg: 22 tags, no new version` | Still polling; no new version yet |
| `ghcr:owner/pkg: INACCESSIBLE — … (needs read:packages scope)` | The package is private and the gh token can't read it — **terminal (failure)**, fails gracefully without crashing the watch |
| `release-watch: all targets reached a terminal state` | Final line; script exits (exit 1 if any target hit a failure terminal, else 0) |

How to react:

- **`RELEASED` / `PUBLISHED`** — the release is out. Report the version. If you were running a deploy/version-bump follow-up (e.g. bumping the image tag in homelab-k8s), this is your go signal — but first confirm the tag carries your change (rapid merges can each cut their own version).
- **`RUN failure …`** — the release workflow failed; the release didn't publish. Surface the run URL and investigate (`gh run view <id> --log-failed`).
- **`RUN success — no new release` / `idle …`** — nothing published. Usually the merge carried no `semver:*` label (opt-in repos) or wasn't a release. If a release *was* expected, check the PR's labels and the release workflow's `detect` job.
- **`INACCESSIBLE`** — the GHCR package is private and this token lacks `read:packages`. The watch continues for any other targets and exits non-zero. To read private packages, the `gh` token needs the `read:packages` scope (public packages read anonymously).

If the user changes their mind mid-watch, call `TaskStop` to cancel early.

## Notes

- Poll interval defaults to 30s (remote-API-safe). Override via `GIT_TOOLING_RELEASE_POLL_SECONDS` only if the user explicitly wants faster/slower polling (respect rate limits).
- **GHCR detection** uses the GitHub REST packages API (`/users/<owner>/packages/container/<pkg>/versions`) when the token has `read:packages` — authoritative, newest-first, with full tag metadata. Nested package names are URL-encoded (`charts/hermes` → `charts%2Fhermes`). When that scope is absent, it falls back to the anonymous OCI registry (`ghcr.io/v2/<pkg>/tags/list`), which reads **public** packages with no special scope. Private packages with an unscoped token fail gracefully (`INACCESSIBLE`), never crash.
- **No-`--tag` GHCR** watches for any *new* tag (set difference vs the start baseline) **or** the reference tag (`latest`, or your `--tag`) repointing to a new digest — so both "new immutable version tag" and "moving `latest` re-pushed to a new build" count as a publish.
- **Repo release** anchors on the most recent run of the release workflow (file basename `release.yml`/`auto-release.yml`, or a workflow whose name contains "release") plus `releases/latest`. A change to `releases/latest` vs the baseline is the publish signal; the workflow run's conclusion is what makes a *failure* visible instead of silent.
- **Already-published detection**: pass `--tag` for a tag that already exists and the script reports it and exits immediately (like ci-watch detecting an already-merged PR).
- The script's stdout is one notification per line; lines within 200ms are batched by the Monitor tool.
- For a one-shot snapshot without watching, use `gh release view <tag>` or `gh run list --workflow release.yml -L 1`.
