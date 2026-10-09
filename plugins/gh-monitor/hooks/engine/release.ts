/**
 * The release stage machine: a merge (or a dispatched/watched run) walked
 * through workflow -> tag -> GitHub release -> image/chart, each stage
 * ending in an explicit outcome rather than silence. The step functions are
 * pure (observation in, state out); `advance` does the reads for one poll.
 */
import type { GitHubClient, RunObs, Scope, TagObs, VersionObs, Workflow } from './github'
import { isReleaseRun } from './github'
import type { Outcome, ReleaseStage, ReleaseView, Repo } from './model'

/** Gate off: how long a merge may go without a release run before it ends as `no-run`. */
export const NO_RUN_GRACE_MS = 3 * 60_000
/** How long after a successful run the tag may take to appear before `no-version-cut`. */
export const TAG_GRACE_MS = 90_000
/** How long after the tag its GitHub Release may take before `tagged-only`. */
export const RELEASE_GRACE_MS = 2 * 60_000
/** A dispatched run may be created up to this long before the dispatch was seen (clock skew). */
export const DISPATCH_SKEW_MS = 60_000

export type Package = { scope: Scope; owner: string; name: string }

/** Everything the engine keeps about one release watch (JSON-safe: it is persisted). */
export type ReleaseState = {
  repo: Repo
  workflow: Workflow
  stage: ReleaseStage
  armedAt: number
  deadline: number
  /** The commit the release is for: the merge commit, or the watched run's head. */
  mergeSha?: string
  mergedAt?: number
  /** A specific run (dispatched / `gh run watch` / discovered), once known. */
  runId?: number
  /** `gh workflow run` seen at this time: wait for a dispatched run created after it. */
  dispatchedAt?: number
  /** A repo watch with no run yet: take the first release run (any event) created after this. */
  waitRunSince?: number
  runStatus?: ReleaseView['runStatus']
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
  image?: Package & { digest?: string; ref?: string }
  chart?: Package & { version?: string }
}

export type Step = { rel: ReleaseState; done?: Outcome }

const STAGES_ALL: readonly ReleaseStage[] = ['run', 'tag', 'release', 'artifacts']

export function stagesOf(rel: ReleaseState): ReleaseStage[] {
  return rel.image || rel.chart ? [...STAGES_ALL] : STAGES_ALL.slice(0, 3)
}

const fileOf = (wf: Workflow) => wf.path.split('/').pop() ?? wf.path

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
    workflow: fileOf(rel.workflow),
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
  const wf = fileOf(rel.workflow)
  if (run === null) {
    const stale = rel.noRunGrace && !rel.floatingTag && rel.runId === undefined && now - rel.armedAt >= NO_RUN_GRACE_MS
    return stale ? { rel, done: { kind: 'no-run', workflow: wf } } : { rel }
  }
  const base: ReleaseState = {
    ...rel,
    runId: run.id,
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
  return now - since >= TAG_GRACE_MS ? { rel, done: { kind: 'no-version-cut', workflow: fileOf(rel.workflow) } } : { rel }
}

/** The release stage: the tag's GitHub Release (null none yet, undefined unreadable). */
export function stepRelease(rel: ReleaseState, release: { draft: boolean } | null | undefined, now: number): Step {
  const tag = rel.tag as string
  if (release && !release.draft) {
    return rel.image || rel.chart ? { rel: { ...rel, stage: 'artifacts' } } : { rel, done: { kind: 'released', tag } }
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

/**
 * The artifacts stage: image and chart versions carrying the release. A
 * failed read (undefined) keeps waiting; every artifact found -> published.
 */
export function stepArtifacts(
  rel: ReleaseState,
  images: readonly VersionObs[] | undefined,
  charts: readonly VersionObs[] | undefined,
  registry: string,
): Step {
  const tag = rel.tag as string
  let next = rel
  if (next.image && !next.image.digest && images) {
    const wanted = imageTagsFor(tag)
    const found = images.find(v => v.tags.some(t => wanted.includes(t)))
    if (found) {
      const t = found.tags.includes(tag) ? tag : (found.tags.find(x => wanted.includes(x)) as string)
      next = { ...next, image: { ...next.image, digest: found.digest, ref: `${registry}/${next.image.owner}/${next.image.name}:${t}` } }
    }
  }
  if (next.chart && !next.chart.version && charts) {
    const want = chartVersionFor(tag)
    if (charts.some(v => v.tags.includes(want))) next = { ...next, chart: { ...next.chart, version: want } }
  }
  const done = (!next.image || next.image.digest) && (!next.chart || next.chart.version)
  if (!done) return { rel: next }
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
    if (rel.image && !rel.image.digest) missing.push('image')
    if (rel.chart && !rel.chart.version) missing.push('chart')
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
export async function observeRun(gh: GitHubClient, rel: ReleaseState): Promise<RunObs | null | undefined> {
  if (rel.runId !== undefined) return gh.runById(rel.repo, rel.runId)
  if (rel.mergeSha) {
    const runs = await gh.runsForSha(rel.repo, rel.mergeSha)
    if (runs === undefined) return undefined
    const run = runs.find(r => isReleaseRun(r, rel.workflow))
    if (run || !rel.floatingTag) return run ?? null
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
  if (now >= rel.deadline) return { rel, done: timeoutOf(rel, timeoutMs) }
  let step: Step = { rel }
  for (let hops = 0; hops < 4; hops++) {
    const before = step.rel.stage
    const cur = step.rel
    switch (cur.stage) {
      case 'run':
        step = stepRun(cur, await observeRun(gh, cur), now)
        break
      case 'tag':
        step = stepTag(cur, await observeTags(gh, cur), now)
        break
      case 'release':
        step = stepRelease(cur, await gh.release(cur.repo, cur.tag as string), now)
        break
      case 'artifacts': {
        const images = cur.image && !cur.image.digest ? await gh.versions(cur.image.scope, cur.image.owner, cur.image.name) : undefined
        const charts = cur.chart && !cur.chart.version ? await gh.versions(cur.chart.scope, cur.chart.owner, cur.chart.name) : undefined
        step = stepArtifacts(cur, images, charts, registry)
        break
      }
    }
    if (step.done || step.rel.stage === before) break
  }
  return step
}

/** The container packages a repo publishes on GHCR: `{name}` and `charts/{name}`. */
export async function probePackages(
  gh: GitHubClient,
  repo: Repo,
): Promise<{ image?: Package; chart?: Package }> {
  const [owner, name] = repo.split('/') as [string, string]
  const out: { image?: Package; chart?: Package } = {}
  const image = await gh.packageScope(owner, name)
  if (image) out.image = { scope: image, owner, name }
  const chart = await gh.packageScope(owner, `charts/${name}`)
  if (chart) out.chart = { scope: chart, owner, name: `charts/${name}` }
  return out
}
