/**
 * The release stage machine: a merge (or a dispatched/watched run) walked
 * through workflow -> tag -> GitHub release -> image/chart, each stage
 * ending in an explicit outcome rather than silence. The step functions are
 * pure (observation in, state out); `advance` does the reads for one poll.
 */
import type { GitHubClient, PackageRef, RunObs, TagObs, VersionObs, Workflow } from './github'
import { isReleaseLikeRun, isReleaseRun } from './github'
import type { Outcome, ReleaseStage, ReleaseView, Repo } from './model'

/** Gate off: how long a merge may go without a release run before it ends as `no-run`. */
export const NO_RUN_GRACE_MS = 3 * 60_000
/** How long after a successful run the tag may take to appear before `no-version-cut`. */
export const TAG_GRACE_MS = 90_000
/** How long after the tag its GitHub Release may take before `tagged-only`. */
export const RELEASE_GRACE_MS = 2 * 60_000
/** A dispatched run may be created up to this long before the dispatch was seen (clock skew). */
export const DISPATCH_SKEW_MS = 60_000

export type Package = PackageRef
/** The artifacts a release can publish. */
export type ArtifactKind = 'image' | 'chart'

/** Everything the engine keeps about one release watch (JSON-safe: it is persisted). */
export type ReleaseState = {
  repo: Repo
  workflow: Workflow
  stage: ReleaseStage
  armedAt: number
  deadline: number
  /** The commit the release is for: the merge commit, or the watched run's head. */
  mergeSha?: string
  /** The PR's head commit: a release workflow on `pull_request: closed` runs on it, not the merge. */
  prHeadSha?: string
  mergedAt?: number
  /** A specific run (dispatched / `gh run watch` / discovered), once known. */
  runId?: number
  /** `gh workflow run` seen at this time: wait for a dispatched run created after it. */
  dispatchedAt?: number
  /** A repo watch with no run yet: take the first release run (any event) created after this. */
  waitRunSince?: number
  runStatus?: ReleaseView['runStatus']
  /** The file of the run actually followed, when it isn't the configured workflow (auto-release.yml calling release.yml). */
  runFile?: string
  runUrl?: string
  runStartedAt?: number
  runDoneAt?: number
  /** Tags that existed at arm time. */
  baselineTags: string[]
  tag?: string
  tagSha?: string
  tagSeenAt?: number
  /** /watch-release --tag: the tag to wait for. */
  wantTag?: string
  floatingTag?: string
  /** Gate off: give up with `no-run` after NO_RUN_GRACE_MS without a run. */
  noRunGrace: boolean
  /** The image package; `ref` (and `digest`) once the release's version is seen. */
  image?: Package & { digest?: string; ref?: string }
  /** The chart package; `version` once seen. */
  chart?: Package & { version?: string }
  /** Packages that couldn't be told present or absent yet: probed again every poll. */
  probe?: ArtifactKind[]
}

export type Step = { rel: ReleaseState; done?: Outcome }

const STAGES_ALL: readonly ReleaseStage[] = ['run', 'tag', 'release', 'artifacts']

/** Whether the release may publish artifacts (known packages, or ones still being probed). */
function hasArtifacts(rel: ReleaseState): boolean {
  return Boolean(rel.image || rel.chart || rel.probe?.length)
}

export function stagesOf(rel: ReleaseState): ReleaseStage[] {
  return hasArtifacts(rel) ? [...STAGES_ALL] : STAGES_ALL.slice(0, 3)
}

const fileOf = (wf: Workflow) => wf.path.split('/').pop() ?? wf.path
/** The workflow file to name in the UI: the run followed, else the configured one. */
const shownFile = (rel: ReleaseState) => rel.runFile ?? fileOf(rel.workflow)

/** The UI's view of a release watch. */
export function viewOf(rel: ReleaseState): ReleaseView {
  const stages = stagesOf(rel)
  const artifacts =
    rel.image || rel.chart
      ? {
          ...(rel.image ? { image: { pkg: `${rel.image.owner}/${rel.image.name}`, ...(rel.image.digest ? { digest: rel.image.digest } : {}) } } : {}),
          ...(rel.chart ? { chart: { pkg: `${rel.chart.owner}/${rel.chart.name}`, ...(rel.chart.version ? { version: rel.chart.version } : {}) } } : {}),
        }
      : undefined
  return {
    stage: rel.stage,
    step: stages.indexOf(rel.stage) + 1,
    total: stages.length === 4 ? 4 : 3,
    workflow: shownFile(rel),
    ...(rel.runStatus ? { runStatus: rel.runStatus } : {}),
    ...(rel.runUrl ? { runUrl: rel.runUrl } : {}),
    ...(rel.runStartedAt !== undefined ? { runStartedAt: rel.runStartedAt } : {}),
    ...(rel.tag ? { tag: rel.tag } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(rel.floatingTag ? { floatingTag: rel.floatingTag } : {}),
    ...(rel.wantTag ? { wantTag: rel.wantTag } : {}),
    deadline: rel.deadline,
  }
}

const RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'])
const QUIET = new Set(['skipped', 'neutral'])

/**
 * The run stage. `run` is the release run (null: none yet, undefined: the
 * read failed). Gate off and no run after the grace -> `no-run`; a floating
 * repo or the gate on keeps waiting until the deadline.
 */
export function stepRun(rel: ReleaseState, run: RunObs | null | undefined, now: number): Step {
  if (run === undefined) return { rel }
  const runFile = run?.path ? run.path.replace(/@.*$/, '').split('/').pop() : undefined
  const wf = runFile ?? shownFile(rel)
  if (run === null) {
    const stale = rel.noRunGrace && !rel.floatingTag && rel.runId === undefined && now - rel.armedAt >= NO_RUN_GRACE_MS
    return stale ? { rel, done: { kind: 'no-run', workflow: wf } } : { rel }
  }
  const base: ReleaseState = {
    ...rel,
    runId: run.id,
    ...(runFile && runFile !== fileOf(rel.workflow) ? { runFile } : {}),
    ...(RUN_STATUSES.has(run.status) ? { runStatus: run.status as ReleaseView['runStatus'] } : {}),
    ...(run.url ? { runUrl: run.url } : {}),
    ...(run.startedAt !== undefined ? { runStartedAt: run.startedAt } : {}),
    ...(rel.mergeSha === undefined && run.headSha ? { mergeSha: run.headSha } : {}),
  }
  if (run.status !== 'completed') return { rel: base }
  const conclusion = run.conclusion ?? 'unknown'
  if (conclusion === 'success') return { rel: { ...base, stage: 'tag', runDoneAt: now } }
  if (QUIET.has(conclusion)) return { rel: base, done: { kind: 'no-version-cut', workflow: wf } }
  return { rel: base, done: { kind: 'failed', workflow: wf, conclusion, ...(run.url ? { url: run.url } : {}) } }
}

/**
 * The tag stage: a tag new since arm time on the release commit or a commit
 * descending from it (or exactly `wantTag`). None TAG_GRACE_MS after the run
 * succeeded -> `no-version-cut` (the run cut nothing).
 */
export function stepTag(rel: ReleaseState, tags: readonly TagObs[] | undefined, now: number): Step {
  if (tags === undefined) return { rel }
  const toRelease = (t: TagObs): Step => ({ rel: { ...rel, stage: 'release', tag: t.name, tagSha: t.sha, tagSeenAt: now } })
  if (rel.wantTag) {
    const want = tags.find(t => t.name === rel.wantTag)
    if (want) return toRelease(want)
  } else {
    const baseline = new Set(rel.baselineTags)
    const fresh = tags.filter(t => !baseline.has(t.name) && t.name !== rel.floatingTag)
    const found = fresh.find(t => t.sha === rel.mergeSha) ?? fresh.find(t => t.related === true)
    if (found) return toRelease(found)
    const unrelated = fresh.filter(t => t.related === false).map(t => t.name)
    if (unrelated.length > 0) rel = { ...rel, baselineTags: [...rel.baselineTags, ...unrelated] }
  }
  const since = rel.runDoneAt ?? now
  return now - since >= TAG_GRACE_MS ? { rel, done: { kind: 'no-version-cut', workflow: shownFile(rel) } } : { rel }
}

/** The release stage: the tag's GitHub Release (null none yet, undefined unreadable). */
export function stepRelease(rel: ReleaseState, release: { draft: boolean } | null | undefined, now: number): Step {
  const tag = rel.tag as string
  if (release && !release.draft) {
    return hasArtifacts(rel) ? { rel: { ...rel, stage: 'artifacts' } } : { rel, done: { kind: 'released', tag } }
  }
  if (release === undefined) return { rel }
  const since = rel.tagSeenAt ?? now
  return now - since >= RELEASE_GRACE_MS ? { rel, done: { kind: 'tagged-only', tag } } : { rel }
}

/** The registry tags an image version for release `tag` may carry: `v1.2.3` and `1.2.3`. */
export function imageTagsFor(tag: string): string[] {
  return /^v\d/.test(tag) ? [tag, tag.slice(1)] : [tag]
}

/** A chart's version for release `tag`: the tag without its leading `v`. */
export function chartVersionFor(tag: string): string {
  return /^v\d/.test(tag) ? tag.slice(1) : tag
}

/** What one poll saw of the image: the tag form found and its digest; null none yet; undefined unreadable. */
export type ImageObs = { tag: string; digest?: string } | null | undefined

/** The image version carrying release `tag` in a Packages API version list (`v1.2.3` preferred over `1.2.3`). */
export function imageIn(versions: readonly VersionObs[] | undefined, tag: string): ImageObs {
  if (!versions) return undefined
  for (const form of imageTagsFor(tag)) {
    const v = versions.find(x => x.tags.includes(form))
    if (v) return { tag: form, digest: v.digest }
  }
  return null
}

/** Applies a re-probe of packages that were unknown: found ones join, absent ones drop, unknown stay. */
export function applyProbes(rel: ReleaseState, probes: Partial<Record<ArtifactKind, PackageRef | 'absent' | 'unknown'>>): ReleaseState {
  if (!rel.probe?.length) return rel
  let next: ReleaseState = { ...rel }
  const still: ArtifactKind[] = []
  for (const kind of rel.probe) {
    const p = probes[kind]
    if (p === undefined || p === 'unknown') still.push(kind)
    else if (p !== 'absent') next = { ...next, [kind]: p }
  }
  if (still.length > 0) next.probe = still
  else delete next.probe
  return next
}

/**
 * The artifacts stage: the image and chart versions carrying the release.
 * A failed read (undefined) or a package still being probed keeps waiting;
 * every artifact seen -> published.
 */
export function stepArtifacts(rel: ReleaseState, image: ImageObs, chartSeen: boolean | undefined, registry: string): Step {
  const tag = rel.tag as string
  let next = rel
  if (next.image && !next.image.ref && image) {
    next = {
      ...next,
      image: { ...next.image, digest: image.digest ?? image.tag, ref: `${registry}/${next.image.owner}/${next.image.name}:${image.tag}` },
    }
  }
  if (next.chart && !next.chart.version && chartSeen) next = { ...next, chart: { ...next.chart, version: chartVersionFor(tag) } }
  const done = !next.probe?.length && (!next.image || next.image.ref) && (!next.chart || next.chart.version)
  if (!done) return { rel: next }
  if (!next.image && !next.chart) return { rel: next, done: { kind: 'released', tag } }
  return {
    rel: next,
    done: {
      kind: 'published',
      tag,
      ...(next.image?.ref ? { image: next.image.ref } : {}),
      ...(next.chart?.version ? { chart: next.chart.version } : {}),
    },
  }
}

/** The outcome of a watch that hit its deadline. */
export function timeoutOf(rel: ReleaseState, timeoutMs: number): Outcome {
  if (rel.stage === 'artifacts' && rel.tag) {
    const missing: ('image' | 'chart')[] = []
    if ((rel.image && !rel.image.ref) || rel.probe?.includes('image')) missing.push('image')
    if ((rel.chart && !rel.chart.version) || rel.probe?.includes('chart')) missing.push('chart')
    return { kind: 'released', tag: rel.tag, ...(missing.length ? { missing } : {}) }
  }
  return { kind: 'timeout', stage: rel.stage, minutes: Math.round(timeoutMs / 60_000) }
}

/** Whether the floating tag is checked at this outcome (not on a failure or no run, where nothing moved). */
export function checksFloatingTag(rel: ReleaseState, done: Outcome): boolean {
  return (
    rel.floatingTag !== undefined &&
    ['published', 'released', 'tagged-only', 'no-version-cut', 'timeout'].includes(done.kind)
  )
}

/** Whether the floating tag was left behind: it should point at the new tag's commit, else the merge commit. */
export function isFloatingTagStale(rel: ReleaseState, floatingSha: string | undefined): boolean {
  if (!floatingSha) return false
  const want = rel.tagSha ?? rel.mergeSha
  return want !== undefined && floatingSha !== want
}

// ── reads ────────────────────────────────────────────────────────────────

/**
 * The release run for this watch: a known run by id; else the newest run of
 * the release workflow for the merge commit (matched by workflow id, so the
 * display name `Release` and the file `release.yml` both match); a floating
 * repo also takes a run dispatched after the merge; a dispatch takes the
 * first dispatched run created after it.
 */
export async function observeRun(gh: GitHubClient, rel: ReleaseState, now: number): Promise<RunObs | null | undefined> {
  if (rel.runId !== undefined) return gh.runById(rel.repo, rel.runId)
  if (rel.mergeSha) {
    const runs = await gh.runsForSha(rel.repo, rel.mergeSha)
    if (runs === undefined) return undefined
    // The release workflow's own run; else a release-looking caller (auto-release.yml -> release.yml via workflow_call).
    const own = runs.find(r => isReleaseRun(r, rel.workflow))
    if (own) return own
    const like = runs.find(isReleaseLikeRun)
    if (like && (await mayFallBack(gh, rel, now))) return like
    if (rel.prHeadSha && rel.prHeadSha !== rel.mergeSha) {
      // A release on `pull_request: closed` runs on the PR's head commit, not the merge.
      const onHead = await gh.runsForSha(rel.repo, rel.prHeadSha)
      if (onHead === undefined) return undefined
      const since = (rel.mergedAt ?? rel.armedAt) - DISPATCH_SKEW_MS
      const closed = onHead.find(
        r => r.event === 'pull_request' && (r.createdAt ?? 0) >= since && isReleaseRun(r, rel.workflow),
      )
      if (closed) return closed
      const closedLike = onHead.find(r => r.event === 'pull_request' && (r.createdAt ?? 0) >= since && isReleaseLikeRun(r))
      if (closedLike && (await mayFallBack(gh, rel, now))) return closedLike
    }
    if (!rel.floatingTag) return null
  }
  if (rel.floatingTag || rel.dispatchedAt !== undefined) {
    const since = rel.dispatchedAt !== undefined ? rel.dispatchedAt - DISPATCH_SKEW_MS : (rel.mergedAt ?? rel.armedAt)
    const runs = await gh.dispatchedRuns(rel.repo, rel.workflow)
    if (runs === undefined) return undefined
    // Oldest qualifying first: the run this dispatch started, not a later one.
    const after = runs.filter(r => (r.createdAt ?? 0) >= since).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return after[0] ?? null
  }
  if (rel.waitRunSince !== undefined) {
    const since = rel.waitRunSince - DISPATCH_SKEW_MS
    const runs = await gh.workflowRuns(rel.repo, rel.workflow)
    if (runs === undefined) return undefined
    const after = runs.filter(r => (r.createdAt ?? 0) >= since).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return after[0] ?? null
  }
  return null
}

/**
 * Whether a release-looking run of another workflow may stand in for the
 * configured one: when the configured workflow never runs by itself (only
 * through `workflow_call`, so it has no run history), or when it has had the
 * run grace to start and didn't. A release-drafter run seen first therefore
 * never locks out a release.yml run created a poll later.
 */
async function mayFallBack(gh: GitHubClient, rel: ReleaseState, now: number): Promise<boolean> {
  if (now - (rel.mergedAt ?? rel.armedAt) >= NO_RUN_GRACE_MS) return true
  return (await gh.hasOwnRuns(rel.repo, rel.workflow)) === false
}

async function observeTags(gh: GitHubClient, rel: ReleaseState): Promise<TagObs[] | undefined> {
  const tags = await gh.newestTags(rel.repo)
  if (!tags || rel.wantTag) return tags
  const baseline = new Set(rel.baselineTags)
  const out: TagObs[] = []
  for (const t of tags) {
    if (baseline.has(t.name) || t.name === rel.floatingTag || !rel.mergeSha) {
      out.push(t)
      continue
    }
    const related = await gh.descends(rel.repo, rel.mergeSha, t.sha)
    out.push(related === undefined ? t : { ...t, related })
  }
  return out
}

/**
 * The tags that existed before this release: commits dated before `cutoff`
 * (the merge, or well before the watched run). Newer or undated tags are
 * left out and later checked by ancestry, so a release that tagged before
 * the watch armed (the person said "merged" late) is still found.
 */
export function baselineOf(tags: readonly TagObs[], cutoff: number): string[] {
  return tags.filter(t => t.date !== undefined && t.date < cutoff).map(t => t.name)
}

/** Walks one release watch as far as this poll's reads allow. */
export async function advance(
  gh: GitHubClient,
  rel: ReleaseState,
  now: number,
  timeoutMs: number,
  registry: string,
): Promise<Step> {
  let step: Step = { rel }
  for (let hops = 0; hops < 4; hops++) {
    const before = step.rel.stage
    const cur = step.rel
    switch (cur.stage) {
      case 'run':
        step = stepRun(cur, await observeRun(gh, cur, now), now)
        break
      case 'tag':
        step = stepTag(cur, await observeTags(gh, cur), now)
        break
      case 'release':
        step = stepRelease(cur, await gh.release(cur.repo, cur.tag as string), now)
        break
      case 'artifacts': {
        const probed = cur.probe?.length ? applyProbes(cur, await probeKinds(gh, cur.repo, registry, cur.probe)) : cur
        const image = probed.image && !probed.image.ref ? await observeImage(gh, probed.image, probed.tag as string, registry) : undefined
        const chart = probed.chart && !probed.chart.version ? await observeChart(gh, probed.chart, probed.tag as string, registry) : undefined
        step = stepArtifacts(probed, image, chart, registry)
        break
      }
    }
    if (step.done || step.rel.stage === before) break
  }
  // The deadline is checked after this poll's look, so a merge noticed late still gets one real read.
  if (!step.done && now >= step.rel.deadline) return { rel: step.rel, done: timeoutOf(step.rel, timeoutMs) }
  return step
}

async function observeImage(gh: GitHubClient, pkg: Package, tag: string, registry: string): Promise<ImageObs> {
  if (pkg.via === 'api') return imageIn(await gh.versions(pkg.scope, pkg.owner, pkg.name), tag)
  return gh.registryVersion(registry, pkg.owner, pkg.name, imageTagsFor(tag))
}

async function observeChart(gh: GitHubClient, pkg: Package, tag: string, registry: string): Promise<boolean | undefined> {
  const version = chartVersionFor(tag)
  if (pkg.via === 'api') {
    const versions = await gh.versions(pkg.scope, pkg.owner, pkg.name)
    return versions ? versions.some(v => v.tags.includes(version)) : undefined
  }
  const seen = await gh.registryVersion(registry, pkg.owner, pkg.name, [version])
  return seen === undefined ? undefined : seen !== null
}

async function probeKinds(
  gh: GitHubClient,
  repo: Repo,
  registry: string,
  kinds: readonly ArtifactKind[],
): Promise<Partial<Record<ArtifactKind, PackageRef | 'absent' | 'unknown'>>> {
  // GHCR package names are lower case; a repo like Acme/Widget publishes acme/widget.
  const [owner, name] = repo.toLowerCase().split('/') as [string, string]
  const out: Partial<Record<ArtifactKind, PackageRef | 'absent' | 'unknown'>> = {}
  for (const kind of kinds) out[kind] = await gh.probePackage(registry, owner, kind === 'image' ? name : `charts/${name}`)
  return out
}

/**
 * The container packages a repo publishes: `{name}` and `charts/{name}`.
 * Packages that couldn't be told present or absent are listed in `probe`
 * and asked again on later polls; one blip never drops them for good.
 */
export async function probePackages(
  gh: GitHubClient,
  repo: Repo,
  registry: string,
): Promise<{ image?: Package; chart?: Package; probe?: ArtifactKind[] }> {
  const probes = await probeKinds(gh, repo, registry, ['image', 'chart'])
  const out: { image?: Package; chart?: Package; probe?: ArtifactKind[] } = {}
  const probe: ArtifactKind[] = []
  for (const kind of ['image', 'chart'] as const) {
    const p = probes[kind]
    if (p === 'unknown' || p === undefined) probe.push(kind)
    else if (p !== 'absent') out[kind] = p
  }
  if (probe.length > 0) out.probe = probe
  return out
}
