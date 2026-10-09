/**
 * A scripted GitHub answering every `gh` argv the gh-monitor engine runs,
 * from mutable fields: a test moves a PR or a release along by assigning
 * them (or with the helpers at the bottom). Fake repos only; nothing here
 * touches the network.
 */

export const REPO = 'acme/widget'
export const PR = 12
export const KEY = `${REPO}#${PR}`
export const HEAD_SHA = '1'.repeat(40)
export const MERGE_SHA = 'a'.repeat(40)
export const OLD_SHA = 'b'.repeat(40)
export const RELEASE_SHA = 'c'.repeat(40)
export const DIGEST = `sha256:${'d'.repeat(64)}`
/** The release workflow's id in the default workflow list. */
export const RELEASE_WF = 1
export const CI_WF = 2

export type Answer = { exitCode: number; stdout: string; stderr: string }

/** A check on the PR's head commit: a CheckRun (status/conclusion), a StatusContext (`state`), or null (hidden). */
export type FixtureCheck = { name: string; status?: string; conclusion?: string | null; state?: string } | null

export type FixturePr = {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  labels: string[]
  checks: FixtureCheck[]
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  isDraft?: boolean
  base?: string
  defaultBranch?: string
  mergeSha?: string
  mergedAt?: string
  title?: string
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus?: string
  reviewRequests?: number
  unresolved?: number
  reviews?: string[]
  headSha?: string
  /** The branch `gh pr view <branch>` (or the current branch) finds it by. */
  branch?: string
  /** Workflow runs for the Actions fallback (when a check is hidden). */
  actionRuns?: { name: string; status: string; conclusion: string | null }[]
}

export type FixtureWorkflow = { id: number; name: string; path: string }

export type FixtureRun = {
  id: number
  head_sha: string
  workflow_id: number
  name?: string
  path?: string
  event: string
  status: string
  conclusion: string | null
  created_at: string
  run_started_at?: string
}

export type GitHub = {
  /** PRs by `owner/name#N`. */
  prs: Record<string, FixturePr>
  /** Every repo's workflow list (the default has `Release` at release.yml). */
  workflows: FixtureWorkflow[]
  /** Workflow runs (any repo the release watch reads), newest last is fine: answers sort newest first. */
  runs: FixtureRun[]
  /** Tags, newest commit first (the GraphQL TAG_COMMIT_DATE order); `date` is the commit date (ISO). */
  tags: { name: string; sha: string; date?: string; annotated?: boolean }[]
  /** How a commit relates to the merge commit (`compare/MERGE...sha`). */
  ancestry: Record<string, 'ahead' | 'behind' | 'diverged' | 'identical'>
  /** Tags with a published GitHub Release; `drafts` have a draft one. */
  releases: string[]
  drafts: string[]
  /** Where the repo's container packages live: the image `{name}` and the chart `charts/{name}`. */
  packages: { image?: 'users' | 'orgs'; chart?: 'users' | 'orgs' }
  /**
   * How the Packages API answers this token: 'ok', or 'forbidden' (403 "need
   * read:packages", the real default for a `gh auth login` token).
   */
  packagesApi: 'ok' | 'forbidden'
  /** Packages that exist but are private: the anonymous registry denies them. */
  privatePackages: boolean
  imageVersions: { digest: string; tags: string[] }[]
  chartVersions: { tags: string[] }[]
  /** Floating tag name -> its commit. */
  floating: Record<string, string>
  /** Argv substrings answered with a transient failure (HTTP 502). */
  broken: string[]
  /** `gh pr list --state merged` for the current repo, newest first. */
  mergedList: { number: number; url: string; mergedAt: string }[]
  /** The repo `gh repo view` reports. */
  currentRepo: string
  /** The branch a bare `gh pr view` looks up. */
  currentBranch: string
  /** Repos that do not exist (every read 404s). */
  missingRepos: string[]
}

const T0 = '1970-01-01T00:00:00.000Z'
export const iso = (ms: number) => new Date(ms).toISOString()

export function openPr(overrides: Partial<FixturePr> = {}): FixturePr {
  return {
    state: 'OPEN',
    labels: [],
    checks: [],
    reviewDecision: 'REVIEW_REQUIRED',
    isDraft: false,
    base: 'main',
    defaultBranch: 'main',
    title: 'Add the thing',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewRequests: 1,
    unresolved: 0,
    reviews: [],
    headSha: HEAD_SHA,
    branch: 'feat/thing',
    ...overrides,
  }
}

export function github(o: Partial<GitHub> = {}): GitHub {
  return {
    prs: { [KEY]: openPr() },
    workflows: [
      { id: RELEASE_WF, name: 'Release', path: '.github/workflows/release.yml' },
      { id: CI_WF, name: 'CI', path: '.github/workflows/ci.yml' },
    ],
    runs: [],
    tags: [{ name: 'v1.2.2', sha: OLD_SHA, date: '1969-12-01T00:00:00Z' }],
    ancestry: {},
    releases: ['v1.2.2'],
    drafts: [],
    packages: {},
    packagesApi: 'ok',
    privatePackages: false,
    imageVersions: [{ digest: `sha256:${'e'.repeat(64)}`, tags: ['1.2.2', 'v1.2.2'] }],
    chartVersions: [{ tags: ['1.2.2'] }],
    floating: {},
    broken: [],
    mergedList: [],
    currentRepo: REPO,
    currentBranch: 'feat/thing',
    missingRepos: [],
    ...o,
  }
}

export const running = (name: string): FixtureCheck => ({ name, status: 'IN_PROGRESS', conclusion: null })
export const passed = (name: string): FixtureCheck => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })
export const failed = (name: string): FixtureCheck => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' })
export const skipped = (name: string): FixtureCheck => ({ name, status: 'COMPLETED', conclusion: 'SKIPPED' })

const ok = (data: unknown): Answer => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '' })
const fail = (stderr: string): Answer => ({ exitCode: 1, stdout: '', stderr })
const notFound = fail('gh: Not Found (HTTP 404)')
const broken = fail('gh: Server Error (HTTP 502)')

const prUrl = (key: string) => {
  const [repo, n] = key.split('#') as [string, string]
  return `https://github.com/${repo}/pull/${n}`
}

function nodeOf(key: string, p: FixturePr) {
  const merged = p.state === 'MERGED'
  return {
    number: Number(key.split('#')[1]),
    title: p.title ?? 'Add the thing',
    url: prUrl(key),
    state: p.state,
    isDraft: p.isDraft ?? false,
    mergeable: p.mergeable ?? 'MERGEABLE',
    mergeStateStatus: p.mergeStateStatus ?? 'BLOCKED',
    reviewDecision: p.reviewDecision ?? null,
    mergedAt: merged ? (p.mergedAt ?? T0) : null,
    mergeCommit: merged ? { oid: p.mergeSha ?? MERGE_SHA } : null,
    baseRefName: p.base ?? 'main',
    headRefName: p.branch ?? 'feat/thing',
    baseRepository: { defaultBranchRef: { name: p.defaultBranch ?? 'main' } },
    labels: { nodes: p.labels.map(name => ({ name })) },
    reviewRequests: { totalCount: p.reviewRequests ?? 0 },
    reviewThreads: { nodes: Array.from({ length: p.unresolved ?? 0 }, () => ({ isResolved: false })) },
    latestReviews: { nodes: (p.reviews ?? []).map(state => ({ state })) },
    commits: {
      nodes: [
        {
          commit: {
            oid: p.headSha ?? HEAD_SHA,
            statusCheckRollup:
              p.checks.length === 0
                ? null
                : {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: p.checks.map(c => (c === null ? null : c.state ? { context: c.name, state: c.state } : c)),
                    },
                  },
          },
        },
      ],
    },
  }
}

/** Reads `-f k=v` / `-F k=v` pairs. */
function varsOf(argv: readonly string[]): Map<string, string> {
  const vars = new Map<string, string>()
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-f' || argv[i] === '-F') {
      const v = argv[i + 1] as string
      const eq = v.indexOf('=')
      if (eq > 0) vars.set(v.slice(0, eq), v.slice(eq + 1))
    }
  }
  return vars
}

const runJson = (repo: string, r: FixtureRun) => ({
  ...r,
  name: r.name ?? 'Release',
  path: r.path ?? '.github/workflows/release.yml',
  html_url: `https://github.com/${repo}/actions/runs/${r.id}`,
})

/** Newest first, like the Actions API. */
const newest = (runs: readonly FixtureRun[]) => [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)

/** What `gh <argv...>` prints against this GitHub (the `cwd` is ignored: one current repo). */
export function answer(gh: GitHub, argv: readonly string[]): Answer {
  const line = argv.join(' ')
  if (gh.broken.some(b => line.includes(b))) return broken
  if (line === 'printenv HOME') return { exitCode: 0, stdout: '/home/tester\n', stderr: '' }
  if (argv[0] === 'curl') return registryAnswer(gh, argv)

  if (line.startsWith('gh api graphql ') && line.includes('...PR')) {
    const vars = varsOf(argv)
    const data: Record<string, unknown> = {}
    const errors: unknown[] = []
    for (let i = 0; vars.has(`o${i}`); i++) {
      const key = `${vars.get(`o${i}`)}/${vars.get(`n${i}`)}#${vars.get(`p${i}`)}`
      const p = Object.entries(gh.prs).find(([k]) => k.toLowerCase() === key.toLowerCase())
      if (p) data[`r${i}`] = { pullRequest: nodeOf(p[0], p[1]) }
      else {
        data[`r${i}`] = { pullRequest: null }
        errors.push({ type: 'NOT_FOUND', path: [`r${i}`, 'pullRequest'], message: 'Could not resolve' })
      }
    }
    return { exitCode: errors.length ? 1 : 0, stdout: JSON.stringify({ data, ...(errors.length ? { errors } : {}) }), stderr: '' }
  }

  if (line.startsWith('gh api graphql ') && line.includes('refs(')) {
    const vars = varsOf(argv)
    if (gh.missingRepos.includes(`${vars.get('owner')}/${vars.get('name')}`)) return notFound
    const nodes = gh.tags.slice(0, 20).map(t => {
      const commit = { oid: t.sha, ...(t.date ? { committedDate: t.date } : {}) }
      // An annotated tag points at a tag object; its commit is one level down.
      return { name: t.name, target: t.annotated ? { oid: `0${t.sha.slice(1)}`, target: commit } : commit }
    })
    return ok({ data: { repository: { refs: { nodes } } } })
  }

  if (line === 'gh repo view --json nameWithOwner') return ok({ nameWithOwner: gh.currentRepo })

  const view = /^gh pr view(?: (\S+))?(?: -R (\S+))? --json number,url,state$/.exec(line)
  if (view) {
    const sel = view[1]
    const repo = view[2] ?? gh.currentRepo
    const entries = Object.entries(gh.prs).filter(([k]) => k.toLowerCase().startsWith(`${repo.toLowerCase()}#`))
    const found =
      sel !== undefined && /^\d+$/.test(sel)
        ? entries.find(([k]) => k.endsWith(`#${sel}`))
        : entries.find(([, p]) => p.branch === (sel ?? gh.currentBranch) && (sel !== undefined || p.state === 'OPEN'))
    if (!found) return fail(`no pull requests found for branch "${sel ?? gh.currentBranch}"`)
    const [key, p] = found
    return ok({ number: Number(key.split('#')[1]), url: prUrl(key), state: p.state })
  }

  const list = /^gh pr list -R (\S+) --state (open|merged) --limit (\d+) --json (\S+)$/.exec(line)
  if (list) {
    const [, repo, state, limit] = list as unknown as [string, string, string, string]
    if (state === 'merged') return ok(gh.mergedList.slice(0, Number(limit)))
    const nums = Object.entries(gh.prs)
      .filter(([k, p]) => k.toLowerCase().startsWith(`${repo.toLowerCase()}#`) && p.state === 'OPEN')
      .map(([k]) => ({ number: Number(k.split('#')[1]) }))
      .slice(0, Number(limit))
    return ok(nums)
  }

  const api = /^gh api (\S+)$/.exec(line)?.[1]
  if (!api) return fail(`unscripted: ${line}`)
  const repoM = /^repos\/([^/]+\/[^/]+)\//.exec(api)
  const repo = repoM?.[1] ?? REPO
  if (repoM && gh.missingRepos.includes(repo)) return notFound

  if (api === `repos/${repo}/actions/workflows?per_page=100`) {
    return ok({ total_count: gh.workflows.length, workflows: gh.workflows.map(w => ({ ...w, state: 'active' })) })
  }
  const bySha = new RegExp(`^repos/${repo}/actions/runs\\?head_sha=([0-9a-f]+)&per_page=(?:20|100)$`).exec(api)
  if (bySha) {
    // The scripted runs on that commit, plus a PR head's Actions runs (the hidden-checks fallback).
    const runs = newest(gh.runs.filter(r => r.head_sha === bySha[1])).map(r => runJson(repo, r))
    const p = Object.values(gh.prs).find(v => (v.headSha ?? HEAD_SHA) === bySha[1])
    const all = [...runs, ...(p?.actionRuns ?? [])].slice(0, 100)
    return ok({ total_count: all.length, workflow_runs: all })
  }
  const active = new RegExp(`^repos/${repo}/actions/runs\\?status=in_progress&per_page=10$`).exec(api)
  if (active) {
    const runs = newest(gh.runs.filter(r => r.status === 'in_progress')).slice(0, 10)
    return ok({ total_count: runs.length, workflow_runs: runs.map(r => runJson(repo, r)) })
  }
  const byWf = new RegExp(`^repos/${repo}/actions/workflows/(\\d+)/runs\\?(event=workflow_dispatch&)?per_page=(\\d+)$`).exec(api)
  if (byWf) {
    const id = Number(byWf[1])
    const runs = newest(gh.runs.filter(r => r.workflow_id === id && (!byWf[2] || r.event === 'workflow_dispatch'))).slice(0, Number(byWf[3]))
    return ok({ total_count: runs.length, workflow_runs: runs.map(r => runJson(repo, r)) })
  }
  const byId = new RegExp(`^repos/${repo}/actions/runs/(\\d+)$`).exec(api)
  if (byId) {
    const run = gh.runs.find(r => r.id === Number(byId[1]))
    return run ? ok(runJson(repo, run)) : notFound
  }
  const compare = new RegExp(`^repos/${repo}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`).exec(api)
  if (compare) {
    const [base, head] = [compare[1] as string, compare[2] as string]
    const status =
      base === head
        ? 'identical'
        : (gh.ancestry[head] ?? (head === RELEASE_SHA ? 'ahead' : head === OLD_SHA ? 'behind' : 'diverged'))
    return ok({ status })
  }
  const release = new RegExp(`^repos/${repo}/releases/tags/(.+)$`).exec(api)
  if (release) {
    const tag = decodeURIComponent(release[1] as string)
    if (gh.releases.includes(tag)) return ok({ tag_name: tag, draft: false })
    if (gh.drafts.includes(tag)) return ok({ tag_name: tag, draft: true })
    return notFound
  }
  const pkg = /^(users|orgs)\/([^/]+)\/packages\/container\/([^/?]+)(\/versions\?per_page=30)?$/.exec(api)
  if (pkg) {
    const [, scope, owner, enc, versions] = pkg as unknown as [string, string, string, string, string | undefined]
    const name = decodeURIComponent(enc)
    const [rOwner, rName] = REPO.split('/') as [string, string]
    if (owner !== rOwner) return notFound
    const which = name === rName ? 'image' : name === `charts/${rName}` ? 'chart' : undefined
    if (gh.packagesApi === 'forbidden') return fail('gh: You need at least read:packages scope to list packages. (HTTP 403)')
    if (!which || gh.packages[which] !== scope) return notFound
    if (!versions) return ok({ name, package_type: 'container' })
    const list =
      which === 'image'
        ? gh.imageVersions.map((v, i) => ({ id: i + 1, name: v.digest, metadata: { container: { tags: v.tags } } }))
        : gh.chartVersions.map((v, i) => ({ id: i + 1, name: `sha256:${String(i).padStart(64, '0')}`, metadata: { container: { tags: v.tags } } }))
    return ok(list)
  }
  const commit = new RegExp(`^repos/${repo}/commits/(.+)$`).exec(api)
  if (commit) {
    const sha = gh.floating[decodeURIComponent(commit[1] as string)]
    return sha ? ok({ sha }) : notFound
  }
  return notFound
}

// ── moving the world along ──

/** Merges a PR (default: the default PR, labelled semver:patch, merged at `at`). */
export function mergePr(gh: GitHub, key = KEY, opts: { at?: number; labels?: string[]; base?: string; sha?: string } = {}) {
  const p = gh.prs[key] as FixturePr
  p.state = 'MERGED'
  p.mergedAt = iso(opts.at ?? 0)
  p.mergeSha = opts.sha ?? MERGE_SHA
  p.labels = opts.labels ?? ['semver:patch']
  if (opts.base) p.base = opts.base
}

/** The release workflow run for the merge commit, created at `at` (ms); its status and conclusion. */
export function releaseRun(
  gh: GitHub,
  patch: Partial<FixtureRun> & { at?: number } = {},
): FixtureRun {
  const { at, ...rest } = patch
  const existing = gh.runs.find(r => r.id === (rest.id ?? 100))
  if (existing) {
    Object.assign(existing, rest)
    return existing
  }
  const run: FixtureRun = {
    id: 100,
    head_sha: MERGE_SHA,
    workflow_id: RELEASE_WF,
    event: 'push',
    status: 'in_progress',
    conclusion: null,
    created_at: iso(at ?? 0),
    ...rest,
  }
  gh.runs.push(run)
  return run
}

/** The release run finished with `conclusion`. */
export function finishRun(gh: GitHub, conclusion = 'success', id = 100) {
  releaseRun(gh, { id, status: 'completed', conclusion })
}

/** The release cut by the merge: an annotated tag on the release commit, its GitHub Release published. */
export function cutRelease(gh: GitHub, tag = 'v1.2.3', sha = RELEASE_SHA) {
  gh.tags = [{ name: tag, sha, annotated: true }, ...gh.tags]
  gh.releases = [...gh.releases, tag]
}

/** The anonymous ghcr.io registry: `/token` and `HEAD /v2/<pkg>/manifests/<tag>` (curl argv). */
function registryAnswer(gh: GitHub, argv: readonly string[]): Answer {
  const url = argv[argv.length - 1] as string
  const [rOwner, rName] = REPO.split('/') as [string, string]
  const which = (path: string) => (path === `${rOwner}/${rName}` ? 'image' : path === `${rOwner}/charts/${rName}` ? 'chart' : undefined)
  const token = /^https:\/\/ghcr\.io\/token\?scope=repository:(.+):pull$/.exec(url)
  if (token) {
    const w = which(token[1] as string)
    return w && gh.packages[w] && !gh.privatePackages
      ? ok({ token: `anon-${w}` })
      : ok({ errors: [{ code: 'DENIED', message: 'requested access to the resource is denied' }] })
  }
  const manifest = /^https:\/\/ghcr\.io\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url)
  if (manifest && argv.includes('-I')) {
    const w = which(manifest[1] as string)
    const tag = decodeURIComponent(manifest[2] as string)
    if (!w || !argv.includes(`Authorization: Bearer anon-${w}`)) return { exitCode: 0, stdout: 'HTTP/2 401 \r\n\r\n', stderr: '' }
    const hit = w === 'image' ? gh.imageVersions.find(v => v.tags.includes(tag)) : gh.chartVersions.find(v => v.tags.includes(tag))
    if (!hit) return { exitCode: 0, stdout: 'HTTP/2 404 \r\ncontent-type: application/json\r\n\r\n', stderr: '' }
    const digest = 'digest' in hit ? hit.digest : `sha256:${'f'.repeat(64)}`
    return { exitCode: 0, stdout: `HTTP/2 200 \r\ndocker-content-digest: ${digest}\r\n\r\n`, stderr: '' }
  }
  return { exitCode: 6, stdout: '', stderr: `curl: unscripted ${url}` }
}

/** Only the tag, no GitHub Release. */
export function cutTag(gh: GitHub, tag = 'v1.2.3', sha = RELEASE_SHA) {
  gh.tags = [{ name: tag, sha }, ...gh.tags]
}

/** GHCR got the image for `tag`: tagged `v1.2.3` and `1.2.3`, or (`bare`) only `1.2.3` as real images often are. */
export function pushImage(gh: GitHub, tag = 'v1.2.3', opts: { bare?: boolean } = {}) {
  const tags = opts.bare ? [tag.replace(/^v/, '')] : [tag.replace(/^v/, ''), tag]
  gh.imageVersions = [{ digest: DIGEST, tags }, ...gh.imageVersions]
}

/** GHCR got the chart for `tag` (version without the `v`). */
export function pushChart(gh: GitHub, tag = 'v1.2.3') {
  gh.chartVersions = [{ tags: [tag.replace(/^v/, '')] }, ...gh.chartVersions]
}

/** The release run failed. */
export function failRun(gh: GitHub, conclusion = 'failure') {
  finishRun(gh, conclusion)
}

// ── an engine over this GitHub ──

import { configOf } from '../../hooks/engine/config'
import { createEngine } from '../../hooks/engine/engine'
import type { Engine, Host } from '../../hooks/engine/engine'
import type { Item, MonitorEvent, Snapshot } from '../../hooks/engine/model'

export type Rig = {
  engine: Engine
  gh: GitHub
  /** Every `gh` argv run, joined by spaces. */
  runs: string[]
  /** The cwd each run was given (parallel to `runs`). */
  cwds: (string | undefined)[]
  events: MonitorEvent[]
  snaps: Snapshot[]
  store: Map<string, unknown>
  /** deny: every run rejects (Host maps to null); hang: every run times out (null). */
  ctl: { deny: boolean; hang: boolean; sessionId: string; cwd: string; gate?: Promise<void> }
  /** The most `gh` calls ever in flight at once. */
  maxInflight: () => number
  now: () => number
  /** Sets the clock without firing timers. */
  at: (ms: number) => void
  /** Lets pending work (arms, pokes, a running poll) finish. */
  settle: () => Promise<void>
  /** Moves the clock and fires every timer due, as `$.clock` would. */
  tick: (ms?: number) => Promise<void>
  /** Live `every` timers. */
  timers: () => number
  item: (id: string) => Item | undefined
  kinds: () => string[]
}

/**
 * The engine over a scripted Host: a mock clock (`tick`), a store Map shared
 * between rigs (pass one in to test resume), and `gh` answered by `answer`.
 */
export function engineRig(gh: GitHub, options: Record<string, unknown> = {}, store = new Map<string, unknown>()): Rig {
  let now = 0
  let inflight = 0
  const runs: string[] = []
  const cwds: (string | undefined)[] = []
  const events: MonitorEvent[] = []
  const snaps: Snapshot[] = []
  const ctl: Rig['ctl'] = { deny: false, hang: false, sessionId: 'session-1', cwd: '/work/widget' }
  let maxInflight = 0
  const afters: { at: number; fn: () => void; dead: boolean }[] = []
  const everys: { ms: number; next: number; fn: () => void; dead: boolean }[] = []
  const host: Host = {
    run: async (argv, cwd) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      try {
        runs.push(argv.join(' '))
        cwds.push(cwd)
        await Promise.resolve()
        if (ctl.gate) await ctl.gate
        if (ctl.deny) return null
        if (ctl.hang) return null
        return answer(gh, argv)
      } finally {
        inflight--
      }
    },
    now: async () => now,
    every: (ms, fn) => {
      const t = { ms, next: now + ms, fn, dead: false }
      everys.push(t)
      return { cancel: () => void (t.dead = true) }
    },
    after: (ms, fn) => {
      const t = { at: now + ms, fn, dead: false }
      afters.push(t)
      return { cancel: () => void (t.dead = true) }
    },
    storeGet: async key => store.get(key),
    storeSet: async (key, value) => void store.set(key, JSON.parse(JSON.stringify(value))),
    storeDelete: async key => void store.delete(key),
    storeKeys: async () => [...store.keys()],
    sessionId: async () => ctl.sessionId,
    cwd: async () => ctl.cwd,
  }
  const engine = createEngine(host, configOf(options))
  engine.subscribe((s, ev) => {
    snaps.push(s)
    events.push(...ev)
  })

  const spin = async () => {
    for (let i = 0; i < 400; i++) await Promise.resolve()
  }
  async function settle() {
    for (let round = 0; round < 200; round++) {
      await spin()
      const due = afters.filter(a => !a.dead && a.at <= now)
      if (due.length === 0 && inflight === 0) {
        await spin()
        if (inflight === 0 && !afters.some(a => !a.dead && a.at <= now)) return
      }
      for (const a of due) {
        a.dead = true
        a.fn()
      }
    }
  }
  return {
    engine,
    gh,
    runs,
    cwds,
    events,
    snaps,
    store,
    ctl,
    maxInflight: () => maxInflight,
    now: () => now,
    at: ms => void (now = ms),
    settle,
    tick: async (ms = 30_000) => {
      await settle()
      now += ms
      for (const t of everys) {
        if (t.dead || t.next > now) continue
        t.next = now + t.ms
        t.fn()
        await settle()
      }
      await settle()
    },
    timers: () => everys.filter(t => !t.dead).length,
    item: id => engine.snapshot().items.find(i => i.id === id),
    kinds: () => events.map(e => e.kind),
  }
}

/** Bash tool.call result as register.tsx hands it over (stdout + optional gitOperation). */
export function bashResult(stdout = '', extra: Record<string, unknown> = {}) {
  return { result: { stdout, stderr: '', interrupted: false, ...extra } }
}

/** Monitor tool.call result. */
export function monitorResult(taskId = 'task-1') {
  return { result: { taskId, timeoutMs: 1_800_000 } }
}

export const PR_ID = `pr:${REPO}#${PR}`
