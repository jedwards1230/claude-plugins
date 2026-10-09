/**
 * The engine: one pipeline per PR — checks -> review -> merged (any route)
 * -> release -> published -> (offered) deploy bump. Arms from tool calls,
 * notifications, typed prompts and commands; polls on a timer with one
 * batched GraphQL query for every PR plus a few REST reads per release;
 * hands the UI a Snapshot and the events that matter. `$`-free: everything
 * goes through the Host register.tsx builds.
 */
import {
  bashPrRequests,
  ciWatchRequests,
  mergedLinesIn,
  parseCiWatchCommand,
  parsePrCommands,
  parseReleaseCommands,
  parseReleaseWatchCommand,
  parseWatchPrArgs,
  parseWatchReleaseArgs,
  typedMerged,
} from './arm'
import type { ArmRequest } from './arm'
import { checksOfContexts, classify, factsOf, hasSemverLabel, headOf } from './classify'
import type { Lookup, PrFacts } from './classify'
import { deployTargetFor, floatingTagFor } from './config'
import type { Config } from './config'
import { createGitHub, isReleaseRun, isReleaseWorkflowRef, pickReleaseWorkflow } from './github'
import type { GitHubClient, RunObs, Workflow } from './github'
import type { ArmSource, Item, ItemId, MonitorEvent, Outcome, Repo, Snapshot } from './model'
import {
  advance,
  baselineOf,
  checksFloatingTag,
  isFloatingTagStale,
  probePackages,
  viewOf,
} from './release'
import type { ReleaseState } from './release'
import { isCompleted, isWorthReading, sameRepo, taskIdOf } from './shell'
import { isStaleForeign, keyOf as storeKeyOf, KEY_PREFIX, payloadOf, prune, readSaved, SAVE_DEBOUNCE_MS } from './store'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Host = {
  run: (argv: readonly string[], cwd?: string) => Promise<RunResult | null> // null: could not start / timed out
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  after: (ms: number, fn: () => void) => { cancel: () => void }
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  storeKeys: () => Promise<string[]>
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
}

/** What register.tsx hands the engine for one finished tool call. */
export type ToolSeen = {
  tool: string // 'Bash' | 'Monitor' | other (ignored)
  command?: string // Bash/Monitor command
  result: unknown // the value next(e) resolved to, untouched
}

export type Engine = {
  /** Idempotent: load store, start timer if any item is live. Safe to call from every hook. */
  boot: () => Promise<void>
  /** Before a Bash call runs (bare `gh pr merge` needs the current-branch PR before --delete-branch). */
  beforeTool: (seen: Omit<ToolSeen, 'result'>) => Promise<void>
  /** After a tool call; never throws; arming happens async. */
  afterTool: (seen: ToolSeen) => void
  /** prompt.submit: origin kind as given (composer/bridge/task-notification/...). */
  onPrompt: (text: string, originKind: string) => void
  /** /watch-pr and /watch-release; resolve to the one-line reply. */
  watchPr: (args: string) => Promise<string>
  watchRelease: (args: string) => Promise<string>
  /** /gh-monitor stop <id|all>; band "stop" button. */
  stop: (id: ItemId | 'all') => void
  deployFilled: (id: ItemId) => void
  deployDismissed: (id: ItemId) => void
  snapshot: () => Snapshot
  /** Called after every change (poll, arm, stop) with the new snapshot and the events it produced. */
  subscribe: (fn: (snap: Snapshot, events: readonly MonitorEvent[]) => void) => void
  /** Drains model-facing lines queued for `nudge` (empty unless config.nudge). */
  takeNudges: () => string[]
  shutdown: () => void
}

// ── constants (design §3) ───────────────────────────────────────────────

/** At most this many PRs are watched at once (oldest idle dropped first). */
export const MAX_WATCHES = 30
/** At most this many PRs come from one "every open PR" selection. */
export const MAX_OPEN_PRS = 20
/** How long a PR may show no checks before it reads "no checks configured". */
export const NO_CHECKS_GRACE_MS = 60_000
/** An open PR with no transition this long is dropped silently. */
export const PR_IDLE_MS = 24 * 60 * 60_000
/** Done items stay on the band this long (and keep the timer alive). */
export const DONE_LINGER_MS = 10 * 60_000
/** An unclaimed deploy offer expires this long after its release finished. */
export const OFFER_TTL_MS = 60 * 60_000
/** A PR first seen already merged arms its release only if it merged this recently (routes 1-3). */
export const RECENT_MERGE_MS = 10 * 60_000
/** `gh release view|list` and repo watches pick up a release run finished this recently. */
export const RECENT_RUN_MS = 10 * 60_000
/** A repo's release workflow is cached this long. */
export const WORKFLOW_CACHE_MS = 10 * 60_000
/** Quiet PRs are queried every Nth tick; so is the sweep. */
export const SLOW_EVERY = 4
/** Consecutive failed reads before the UI says GitHub can't be reached. */
export const ERROR_STREAK_OFFLINE = 3
/** A watched release run's tag may predate it by this much (run-based arms). */
const RUN_TAG_LOOKBACK_MS = 60 * 60_000
/** Clock skew tolerated between this machine and GitHub. */
const CLOCK_SKEW_MS = 60_000

// ── internal item ───────────────────────────────────────────────────────

/** A merge noticed but not yet routed (the workflow list or tags were unreadable). */
type PendingMerge = { facts: PrFacts; since: number }

/** Item plus what only the engine needs; persisted as is, stripped by snapshot(). */
type Internal = Item & {
  /** Confirmed by a GitHub read; unconfirmed items are not shown. */
  confirmed: boolean
  /** Where the arming command ran (for `gh` lookups). */
  cwd?: string
  /** When the head commit was first seen (the no-checks grace runs from it). */
  shaSince?: number
  /** Last time something armed or poked this item (the "most recent" PR for a typed merged). */
  touchedAt: number
  /** A merge was announced (notification / typed): query on the next tick. */
  suspect?: boolean
  pendingMerge?: PendingMerge
  rel?: ReleaseState
  /** The words-level signature, to tell a transition from a count change. */
  sig: string
}

const prId = (repo: Repo, pr: number): ItemId => `pr:${repo.toLowerCase()}#${pr}`
const relId = (repo: Repo, at: number): ItemId => `rel:${repo.toLowerCase()}@${at}`
const nameOf = (repo: Repo) => repo.split('/')[1] ?? repo
const labelOf = (i: Item) => (i.pr !== undefined ? `${i.repo}#${i.pr}` : i.repo)

function sigOf(i: Internal): string {
  const v = i.prView
  const r = i.release
  return [
    i.phase,
    v ? `${v.ci}|${v.review}|${v.failing.join(',')}|${v.unresolved}` : '',
    r ? `${r.stage}|${r.runStatus ?? ''}|${r.tag ?? ''}|${r.artifacts?.image?.digest ?? ''}|${r.artifacts?.chart?.version ?? ''}` : '',
    i.outcome ? i.outcome.kind : '',
    i.deploy ? i.deploy.state : '',
    i.pendingMerge ? 'pending' : '',
  ].join('/')
}

/** Item without the engine's internals. */
function publicOf(i: Internal): Item {
  const {
    confirmed: _c,
    cwd: _cwd,
    shaSince: _s,
    touchedAt: _t,
    suspect: _su,
    pendingMerge: _p,
    rel: _r,
    sig: _sig,
    ...item
  } = i
  return item
}

/** Whether a stored item is whole enough to resume (a release needs its workflow). */
function isRestorable(raw: Internal): boolean {
  if (!raw || typeof raw.id !== 'string' || typeof raw.repo !== 'string') return false
  if (!['pr', 'release', 'done'].includes(raw.phase) || typeof raw.armedAt !== 'number') return false
  const rel = raw.rel as Partial<ReleaseState> | undefined
  if (rel !== undefined && (typeof rel !== 'object' || typeof rel.workflow?.path !== 'string' || typeof rel.deadline !== 'number')) return false
  return raw.phase !== 'release' || rel !== undefined
}

/** Whether an item still needs polling or showing. */
function isLive(i: Internal): boolean {
  return i.phase !== 'done'
}

function isFailing(i: Internal): boolean {
  if (i.phase === 'pr' && i.prView) return i.prView.ci === 'failing' || i.prView.review === 'changes' || i.prView.review === 'conflict'
  return i.phase === 'done' && (i.outcome?.kind === 'failed' || i.outcome?.kind === 'timeout')
}

/** §3.4 rank: failing, offers, releasing, checks running, in review/ready, done. */
function rankOf(i: Internal, now: number): number {
  if (isFailing(i) && (i.phase !== 'done' || now - (i.doneAt ?? 0) < DONE_LINGER_MS)) return 1
  if (i.deploy?.state === 'offered') return 2
  if (i.phase === 'release') return 3
  if (i.phase === 'pr' && (i.prView?.ci === 'starting' || i.prView?.ci === 'running' || !i.prView)) return 4
  if (i.phase === 'pr') return 5
  return 6
}

/** What a release watch armed from a known run starts with. */
function runFields(run: RunObs): Partial<ReleaseState> {
  const statuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed']
  return {
    runId: run.id,
    ...(run.headSha ? { mergeSha: run.headSha } : {}),
    ...(statuses.includes(run.status) ? { runStatus: run.status as ReleaseState['runStatus'] } : {}),
    ...(run.url ? { runUrl: run.url } : {}),
    ...(run.startedAt !== undefined ? { runStartedAt: run.startedAt } : {}),
  }
}

// ── the engine ──────────────────────────────────────────────────────────

export function createEngine(host: Host, config: Config): Engine {
  const gh: GitHubClient = createGitHub(host.run)
  const items = new Map<ItemId, Internal>()
  const subscribers: ((snap: Snapshot, events: readonly MonitorEvent[]) => void)[] = []
  const nudges: string[] = []
  /** Monitor task id -> the repos its ci-watch.py watches (to resolve a bare `PR #N: MERGED`). */
  const monitorRepos = new Map<string, Repo[]>()
  /** Bare `gh pr merge` command -> the PR its branch had before the merge ran. */
  const preResolved = new Map<string, Promise<{ repo: Repo; pr: number } | undefined>>()
  const workflowCache = new Map<string, { at: number; wf: Workflow | null }>()
  const repoAtCache = new Map<string, Repo | undefined>()

  let booted: Promise<void> | null = null
  let timer: { cancel: () => void } | null = null
  let saveTimer: { cancel: () => void } | null = null
  let isPolling = false
  let pollAgain = false
  let stopped = false
  let ticks = 0
  let lastNow = 0
  let savedKey: string | undefined
  let home: Promise<string | undefined> | undefined

  // ── emitting ──

  function snapshotAt(now: number): Snapshot {
    const visible = [...items.values()].filter(i => i.confirmed)
    visible.sort((a, b) => {
      const ra = rankOf(a, now)
      const rb = rankOf(b, now)
      if (ra !== rb) return ra - rb
      if (ra === 6) return (b.doneAt ?? 0) - (a.doneAt ?? 0)
      return b.lastTransitionAt - a.lastTransitionAt
    })
    return { now, items: visible.map(publicOf) }
  }

  function emit(events: MonitorEvent[]) {
    const snap = snapshotAt(lastNow)
    if (config.nudge) for (const ev of events) {
      const line = nudgeOf(ev)
      if (line) nudges.push(line)
    }
    for (const fn of subscribers) {
      try {
        fn(snap, events)
      } catch {
        // a subscriber's failure never stops the engine
      }
    }
    scheduleSave()
  }

  function nudgeOf(ev: MonitorEvent): string | undefined {
    const label = labelOf(ev.item)
    switch (ev.kind) {
      case 'checks-failed':
        return `gh-monitor: ${label} checks failed (${ev.names.join(', ')})`
      case 'merged':
        return ev.item.phase === 'release'
          ? `gh-monitor: ${label} merged; watching its release`
          : `gh-monitor: ${label} merged; ${ev.item.outcome?.kind ?? 'done'}`
      case 'outcome': {
        const o = ev.item.outcome
        if (!o) return undefined
        const tag = 'tag' in o ? ` ${o.tag}` : ''
        return `gh-monitor: ${label} ${o.kind}${tag}`
      }
      default:
        return undefined
    }
  }

  /** Re-signs an item after a change; a words change is a transition. */
  function touch(i: Internal, now: number) {
    const sig = sigOf(i)
    if (sig !== i.sig) {
      i.sig = sig
      i.lastTransitionAt = now
    }
  }

  // ── persistence ──

  function scheduleSave() {
    if (saveTimer || stopped) return
    saveTimer = host.after(SAVE_DEBOUNCE_MS, () => {
      saveTimer = null
      void save().catch(() => undefined)
    })
  }

  async function save(): Promise<void> {
    const sid = await host.sessionId()
    const key = storeKeyOf(sid)
    if (savedKey !== undefined && savedKey !== key) await host.storeDelete(savedKey).catch(() => undefined)
    savedKey = key
    const now = await host.now()
    const kept = prune([...items.values()], now)
    if (kept.length === 0) {
      await host.storeDelete(key)
      return
    }
    await host.storeSet(key, payloadOf(kept, now))
  }

  async function load(): Promise<void> {
    const now = await host.now()
    lastNow = now
    const key = storeKeyOf(await host.sessionId())
    savedKey = key
    const saved = readSaved<Internal>(await host.storeGet(key))
    if (saved) {
      for (const raw of prune(saved.items, now)) {
        if (!isRestorable(raw) || items.has(raw.id)) continue
        const i: Internal = { ...raw, errorStreak: 0, suspect: false }
        if (i.deploy?.state === 'offered' && now - (i.doneAt ?? 0) >= OFFER_TTL_MS) i.deploy = { ...i.deploy, state: 'dismissed' }
        items.set(i.id, i)
      }
    }
    // Other sessions' keys left a week ago are garbage.
    for (const k of await host.storeKeys().catch(() => [] as string[])) {
      if (!k.startsWith(KEY_PREFIX) || k === key) continue
      const other = readSaved<unknown>(await host.storeGet(k).catch(() => undefined))
      if (isStaleForeign(k, key, other, now)) await host.storeDelete(k).catch(() => undefined)
    }
  }

  // ── timer ──

  function needsTimer(now: number): boolean {
    for (const i of items.values()) {
      if (isLive(i)) return true
      if (i.deploy?.state === 'offered') return true
      if (i.phase === 'done' && now - (i.doneAt ?? 0) < DONE_LINGER_MS) return true
    }
    return false
  }

  function ensureTimer() {
    if (!timer && !stopped) timer = host.every(config.pollMs, () => void poll().catch(() => undefined))
  }

  function stopTimerIfIdle(now: number) {
    if (timer && !needsTimer(now)) {
      timer.cancel()
      timer = null
    }
  }

  /** An out-of-band poll (a new arm, a merge announced); still never overlaps a running one. */
  function poke() {
    if (stopped) return
    ensureTimer()
    host.after(0, () => void poll().catch(() => undefined))
  }

  // ── lookups ──

  /**
   * A `cd` directory as gh can use it: no shell runs it, so `~` is expanded
   * here (HOME read once) and a relative path joined to the session's cwd.
   */
  async function resolveDir(dir: string | undefined): Promise<string | undefined> {
    if (dir === undefined) return undefined
    if (dir === '~' || dir.startsWith('~/')) {
      home ??= host
        .run(['printenv', 'HOME'])
        .then(r => (r && r.exitCode === 0 && r.stdout.trim().startsWith('/') ? r.stdout.trim() : undefined))
        .catch(() => undefined)
      const h = await home
      return h ? `${h}${dir.slice(1)}` : undefined
    }
    if (dir.startsWith('/')) return dir
    const base = await host.cwd().catch(() => undefined)
    return base ? `${base.replace(/\/+$/, '')}/${dir.replace(/^\.\//, '')}` : dir
  }

  async function repoAt(cwd: string | undefined): Promise<Repo | undefined> {
    const dir = (await resolveDir(cwd)) ?? (await host.cwd().catch(() => undefined))
    const key = dir ?? ''
    if (repoAtCache.has(key)) return repoAtCache.get(key)
    const repo = await gh.repoAt(dir)
    if (repo) repoAtCache.set(key, repo)
    return repo
  }

  /** The repo's release workflow (cached); null: none; undefined: unreadable. */
  async function releaseWorkflow(repo: Repo, now: number): Promise<Workflow | null | undefined> {
    const key = repo.toLowerCase()
    const hit = workflowCache.get(key)
    if (hit && now - hit.at < WORKFLOW_CACHE_MS) return hit.wf
    const list = await gh.workflows(repo)
    if (list === undefined) return undefined
    const wf = list === null ? null : (pickReleaseWorkflow(list, config.releaseWorkflow) ?? null)
    workflowCache.set(key, { at: now, wf })
    return wf
  }

  // ── items ──

  function newItem(id: ItemId, repo: Repo, source: ArmSource, now: number, extra: Partial<Internal> = {}): Internal {
    const i: Internal = {
      id,
      repo,
      source,
      phase: 'pr',
      armedAt: now,
      lastTransitionAt: now,
      errorStreak: 0,
      confirmed: false,
      touchedAt: now,
      sig: '',
      ...extra,
    }
    i.sig = sigOf(i)
    return i
  }

  /**
   * Arms (or refreshes) a PR watch; the next poll confirms it. A finished PR
   * stays finished when touched in passing (no replayed release or toasts),
   * but starts over when asked for by name (`restart`: /watch-pr, a typed
   * "merged #N") or when it ended closed/gone, since GitHub may have reopened
   * it; one that is still closed is then dropped quietly by the first read.
   */
  function addPr(repo: Repo, pr: number, source: ArmSource, now: number, cwd?: string, restart = false): Internal {
    const id = prId(repo, pr)
    const existing = items.get(id)
    if (existing) {
      if (existing.phase !== 'done') {
        existing.touchedAt = now
        return existing
      }
      const reread = existing.outcome?.kind === 'closed' || existing.outcome?.kind === 'gone'
      if (!restart && !reread) return existing
      items.delete(id)
    }
    const i = newItem(id, repo, source, now, { pr, ...(cwd !== undefined ? { cwd } : {}) })
    items.set(id, i)
    enforceMax()
    return i
  }

  /** Keeps at most MAX_WATCHES live PR watches: the longest-idle go first. */
  function enforceMax() {
    const live = [...items.values()].filter(i => i.phase === 'pr')
    if (live.length <= MAX_WATCHES) return
    live.sort((a, b) => a.lastTransitionAt - b.lastTransitionAt || a.touchedAt - b.touchedAt)
    for (const i of live.slice(0, live.length - MAX_WATCHES)) items.delete(i.id)
  }

  /** Whether a live release watch already covers this repo's run (PR items win over PR-less ones). */
  function coveredRelease(repo: Repo, runId: number | undefined): boolean {
    for (const i of items.values()) {
      if (i.phase !== 'release' || !i.rel || !sameRepo(i.repo, repo)) continue
      if (runId === undefined || i.rel.runId === undefined || i.rel.runId === runId) {
        if (i.pr !== undefined || i.rel.runId === runId) return true
      }
    }
    return false
  }

  /** Arms a PR-less release watch, replacing an older PR-less one for the same repo. */
  async function addRelease(
    repo: Repo,
    source: ArmSource,
    wf: Workflow,
    now: number,
    opts: { run?: RunObs; dispatchedAt?: number; waitRunSince?: number; wantTag?: string; tagSha?: string },
  ): Promise<Internal | undefined> {
    if (coveredRelease(repo, opts.run?.id)) return undefined
    const pkgs = config.registry === 'ghcr.io' ? await probePackages(gh, repo, config.registry) : {}
    const tags = await gh.newestTags(repo)
    const cutoff = opts.run ? (opts.run.createdAt ?? now) - RUN_TAG_LOOKBACK_MS : now - CLOCK_SKEW_MS
    const floatingTag = floatingTagFor(config, repo)
    const rel: ReleaseState = {
      repo,
      workflow: wf,
      stage: 'run',
      armedAt: now,
      deadline: now + config.timeoutMs,
      baselineTags: tags ? baselineOf(tags, cutoff) : [],
      noRunGrace: false,
      ...(floatingTag ? { floatingTag } : {}),
      ...(opts.run ? runFields(opts.run) : {}),
      ...(opts.dispatchedAt !== undefined ? { dispatchedAt: opts.dispatchedAt } : {}),
      ...(opts.waitRunSince !== undefined ? { waitRunSince: opts.waitRunSince } : {}),
      ...(pkgs.image ? { image: pkgs.image } : {}),
      ...(pkgs.chart ? { chart: pkgs.chart } : {}),
      ...(pkgs.probe ? { probe: pkgs.probe } : {}),
    }
    if (opts.wantTag) {
      rel.wantTag = opts.wantTag
      if (opts.tagSha) {
        rel.stage = 'release'
        rel.tag = opts.wantTag
        rel.tagSha = opts.tagSha
        rel.tagSeenAt = now
      } else if (!opts.run) {
        rel.stage = 'tag'
      }
    }
    if (stopped || coveredRelease(repo, opts.run?.id)) return undefined
    for (const i of [...items.values()]) {
      if (i.phase === 'release' && i.pr === undefined && sameRepo(i.repo, repo)) items.delete(i.id)
    }
    const i = newItem(relId(repo, now), repo, source, now, { phase: 'release', confirmed: true, rel, release: viewOf(rel) })
    items.set(i.id, i)
    return i
  }

  function finish(i: Internal, outcome: Outcome, now: number) {
    i.phase = 'done'
    i.outcome = outcome
    i.doneAt = now
    delete i.pendingMerge
    delete i.suspect
    if (i.rel) i.release = viewOf(i.rel)
    touch(i, now)
  }

  /** On a published release for a configured app repo: the deploy offer. */
  function offerDeploy(i: Internal, outcome: Outcome): boolean {
    if (outcome.kind !== 'published') return false
    const target = deployTargetFor(config, i.repo)
    if (!target) return false
    const chartVersion = outcome.chart
    i.deploy = {
      target,
      version: outcome.tag,
      ...(outcome.image ? { image: outcome.image } : {}),
      ...(chartVersion ? { chartVersion } : {}),
      state: 'offered',
    }
    return true
  }

  /** Ends a release (outcome, floating-tag nag, deploy offer); returns the events. */
  async function finishRelease(i: Internal, outcome: Outcome, now: number): Promise<MonitorEvent[]> {
    finish(i, outcome, now)
    const events: MonitorEvent[] = [{ kind: 'outcome', item: publicOf(i) }]
    if (offerDeploy(i, outcome)) {
      touch(i, now)
      events.push({ kind: 'deploy-offer', item: publicOf(i) })
    }
    const rel = i.rel
    if (rel?.floatingTag && checksFloatingTag(rel, outcome)) {
      const sha = await gh.commitOf(rel.repo, rel.floatingTag)
      if (isFloatingTagStale(rel, sha)) events.push({ kind: 'floating-tag-stale', item: publicOf(i), tag: rel.floatingTag })
    }
    return events
  }

  /**
   * A PR seen merged: route it (§3.1). Returns the outcome when it ends at
   * once, 'release' when its release is now watched, undefined when a read
   * failed (retried next tick).
   */
  async function routeMerge(i: Internal, facts: PrFacts, now: number): Promise<Outcome | 'release' | undefined> {
    if (facts.base && facts.defaultBranch && facts.base !== facts.defaultBranch) {
      return { kind: 'not-default-branch', base: facts.base }
    }
    const wf = await releaseWorkflow(i.repo, now)
    if (wf === undefined) return undefined
    if (wf === null) return { kind: 'no-release-workflow', workflow: config.releaseWorkflow }
    const floatingTag = floatingTagFor(config, i.repo)
    if (!floatingTag && config.semverLabelGate && !hasSemverLabel(facts.labels)) return { kind: 'no-semver-label' }
    if (!facts.mergeSha) return undefined
    const tags = await gh.newestTags(i.repo)
    if (!tags) return undefined
    const pkgs = config.registry === 'ghcr.io' ? await probePackages(gh, i.repo, config.registry) : {}
    const mergedAt = facts.mergedAt ?? now
    // The hard stop runs from the merge, or from when the merge was first seen if that was later
    // (a suspended laptop, a restart, a late "merged"): a late watch still gets its full look.
    const from = Math.max(mergedAt, now)
    const rel: ReleaseState = {
      repo: i.repo,
      workflow: wf,
      stage: 'run',
      armedAt: now,
      deadline: from + config.timeoutMs,
      mergeSha: facts.mergeSha,
      ...(facts.headSha ? { prHeadSha: facts.headSha } : {}),
      mergedAt,
      baselineTags: baselineOf(tags, mergedAt - CLOCK_SKEW_MS),
      noRunGrace: !config.semverLabelGate,
      ...(floatingTag ? { floatingTag } : {}),
      ...(pkgs.image ? { image: pkgs.image } : {}),
      ...(pkgs.chart ? { chart: pkgs.chart } : {}),
      ...(pkgs.probe ? { probe: pkgs.probe } : {}),
    }
    // A watch made from the release run alone gives way to the PR's.
    for (const other of [...items.values()]) {
      if (other.phase === 'release' && other.pr === undefined && sameRepo(other.repo, i.repo)) items.delete(other.id)
    }
    i.rel = rel
    i.release = viewOf(rel)
    return 'release'
  }

  /** Applies a merge reading to a PR item; returns its events. */
  async function onMerged(i: Internal, facts: PrFacts, now: number): Promise<MonitorEvent[]> {
    if (facts.mergedAt !== undefined) i.mergedAt = facts.mergedAt
    const routed = await routeMerge(i, facts, now)
    if (routed === undefined) {
      i.pendingMerge ??= { facts, since: now }
      touch(i, now)
      // A merge whose release can't be routed before the deadline gives up.
      if (now - i.pendingMerge.since >= config.timeoutMs) {
        finish(i, { kind: 'timeout', stage: 'run', minutes: Math.round(config.timeoutMs / 60_000) }, now)
        return [{ kind: 'merged', item: publicOf(i) }]
      }
      return []
    }
    delete i.pendingMerge
    if (routed === 'release') {
      i.phase = 'release'
      touch(i, now)
      return [{ kind: 'merged', item: publicOf(i) }]
    }
    // Immediate outcome: one 'merged' event with the item already done (the UI shows the outcome toast).
    finish(i, routed, now)
    return [{ kind: 'merged', item: publicOf(i) }]
  }

  // ── arming ──

  async function arm(req: ArmRequest, now: number): Promise<Internal[]> {
    const cwd = 'cwd' in req ? req.cwd : undefined
    switch (req.kind) {
      case 'pr':
        return [addPr(req.repo, req.pr, req.source, now, cwd)]
      case 'pr-lookup': {
        const found = await gh.prView(req.selector, req.repo, cwd)
        if (!found || (req.openOnly && found.state !== 'OPEN')) return []
        return [addPr(found.repo, found.pr, req.source, now, cwd)]
      }
      case 'pr-list': {
        const repo = req.repo ?? (await repoAt(cwd))
        if (!repo) return []
        const prs = await gh.openPrs(repo, MAX_OPEN_PRS, cwd)
        return (prs ?? []).slice(0, MAX_OPEN_PRS).map(pr => addPr(repo, pr, req.source, now, cwd))
      }
      case 'dispatch': {
        const repo = req.repo ?? (await repoAt(cwd))
        if (!repo) return []
        const wf = await releaseWorkflow(repo, now)
        if (!wf || !isReleaseWorkflowRef(req.workflow.replace(/^\.github\/workflows\//, ''), wf)) return []
        const i = await addRelease(repo, req.source, wf, now, { dispatchedAt: now })
        return i ? [i] : []
      }
      case 'run': {
        const repo = req.repo ?? (await repoAt(cwd))
        if (!repo) return []
        const [wf, run] = [await releaseWorkflow(repo, now), await gh.runById(repo, req.runId)]
        if (!wf || !run || !isReleaseRun(run, wf)) return []
        const i = await addRelease(repo, req.source, wf, now, { run })
        return i ? [i] : []
      }
      case 'release': {
        const repo = req.repo ?? (await repoAt(cwd))
        if (!repo) return []
        const wf = await releaseWorkflow(repo, now)
        if (!wf) return []
        const i = await armRepoRelease(repo, req.source, wf, now, req.discover, req.tag)
        return i ? [i] : []
      }
    }
  }

  /**
   * A repo's release with no PR: a specific tag; else the newest release run
   * if active or finished within RECENT_RUN_MS; else (unless discovering)
   * the next run to start.
   */
  async function armRepoRelease(
    repo: Repo,
    source: ArmSource,
    wf: Workflow,
    now: number,
    discover: boolean,
    tag?: string,
  ): Promise<Internal | undefined> {
    if (tag) {
      const tags = await gh.newestTags(repo)
      const hit = tags?.find(t => t.name === tag)
      return addRelease(repo, source, wf, now, { wantTag: tag, ...(hit ? { tagSha: hit.sha } : {}) })
    }
    const runs = await gh.workflowRuns(repo, wf)
    if (runs === undefined && discover) return undefined
    const newest = runs?.[0]
    const recent = newest && (newest.status !== 'completed' || now - (newest.createdAt ?? 0) <= RECENT_RUN_MS)
    if (newest && recent) return addRelease(repo, source, wf, now, { run: newest })
    if (discover) return undefined
    return addRelease(repo, source, wf, now, { waitRunSince: now })
  }

  async function armAll(reqs: readonly ArmRequest[], pre?: { repo: Repo; pr: number }): Promise<void> {
    if (reqs.length === 0 && !pre) return
    const now = await host.now()
    lastNow = now
    let armed = 0
    for (const r of reqs) {
      // A bare `gh pr merge` resolved before it ran (its branch may be gone now).
      if (pre && r.kind === 'pr-lookup' && r.selector === undefined && r.source === 'pr-cmd') {
        addPr(pre.repo, pre.pr, 'pr-cmd', now, r.cwd)
        armed++
        continue
      }
      try {
        let req = r
        if (r.cwd !== undefined) {
          // No shell runs gh: `cd ~/x` and `cd sub` are resolved here.
          const { cwd: raw, ...rest } = r
          const dir = await resolveDir(raw)
          req = (dir !== undefined ? { ...rest, cwd: dir } : rest) as ArmRequest
        }
        armed += (await arm(req, now)).length
      } catch {
        // an arm that fails is an arm that didn't happen
      }
      if (stopped) return
    }
    if (armed > 0) {
      emit([])
      poke()
    }
  }

  // ── polling ──

  /** Applies one PR lookup; returns the events. */
  async function applyPr(i: Internal, l: Lookup | undefined, now: number): Promise<MonitorEvent[]> {
    if (!l || 'transient' in l) {
      i.errorStreak++
      return []
    }
    i.errorStreak = 0
    if ('gone' in l) {
      if (!i.confirmed) {
        items.delete(i.id)
        return []
      }
      finish(i, { kind: 'gone' }, now)
      return [{ kind: 'outcome', item: publicOf(i) }]
    }
    const facts = factsOf(l.node)
    if (facts.title) i.title = facts.title
    if (facts.url) i.url = facts.url
    const fresh = !i.confirmed
    if (fresh) {
      const explicit = i.source === 'command' || i.source === 'typed-merged' || i.source === 'merged-event'
      // An old merge or a closed PR seen by a passing `gh pr view` is history, not something to watch.
      if (facts.state === 'CLOSED' && !explicit) {
        items.delete(i.id)
        return []
      }
      if (facts.state === 'MERGED' && !explicit) {
        const at = facts.mergedAt ?? 0
        if (now - at > RECENT_MERGE_MS || at - now > CLOCK_SKEW_MS) {
          items.delete(i.id)
          return []
        }
      }
      if (facts.state === 'UNKNOWN') return []
      i.confirmed = true
    }
    i.suspect = false
    if (facts.state === 'MERGED') return onMerged(i, facts, now)
    if (facts.state === 'CLOSED') {
      finish(i, { kind: 'closed' }, now)
      return [{ kind: 'outcome', item: publicOf(i) }]
    }
    if (facts.state !== 'OPEN') return []

    const head = headOf(l.node)
    if (head.sha && head.sha !== i.prView?.headSha) i.shaSince = now
    i.shaSince ??= now
    // The rollup hides check-runs this token can't read: count the Actions runs instead (ci-watch.py's fallback).
    const checks =
      (head.hidden && head.sha ? await gh.actionChecks(i.repo, head.sha) : undefined) ?? checksOfContexts(head.contexts)
    const prev = i.prView
    const next = classify(l.node, checks, now - (i.shaSince ?? now) < NO_CHECKS_GRACE_MS)
    i.prView = next
    touch(i, now)
    const events: MonitorEvent[] = []
    if (fresh || !prev) return events
    if (next.ci === 'failing' && prev.ci !== 'failing') events.push({ kind: 'checks-failed', item: publicOf(i), names: next.failing })
    else if (next.ci === 'passed' && ['starting', 'running', 'failing'].includes(prev.ci)) events.push({ kind: 'checks-passed', item: publicOf(i) })
    if (next.review === 'changes' && prev.review !== 'changes') events.push({ kind: 'changes-requested', item: publicOf(i) })
    return events
  }

  async function poll(): Promise<void> {
    if (stopped) return
    if (isPolling) {
      pollAgain = true
      return
    }
    isPolling = true
    const events: MonitorEvent[] = []
    let now = lastNow
    try {
      now = await host.now()
      lastNow = now
      ticks++
      const slowTick = ticks % SLOW_EVERY === 0

      // PRs: one batched query for every live PR, every tick while something moves, else every 4th.
      const prs = [...items.values()].filter(i => i.phase === 'pr' && i.pr !== undefined && !i.pendingMerge)
      for (const i of prs) {
        if (i.confirmed && i.phase === 'pr' && now - i.lastTransitionAt >= PR_IDLE_MS && now - i.touchedAt >= PR_IDLE_MS) items.delete(i.id)
      }
      const livePrs = prs.filter(i => items.has(i.id))
      const busy = livePrs.some(
        i => !i.confirmed || i.suspect || !i.prView || i.prView.ci === 'starting' || i.prView.ci === 'running',
      )
      if (livePrs.length > 0 && (busy || slowTick)) {
        const found = await gh.prs(livePrs.map(i => ({ repo: i.repo, pr: i.pr as number })))
        for (const [k, i] of livePrs.entries()) {
          if (stopped) return
          if (items.get(i.id) !== i) continue
          events.push(...(await guarded(i, () => applyPr(i, found[k], now))))
        }
      }

      // Merges whose release couldn't be routed yet.
      for (const i of [...items.values()]) {
        if (stopped) return
        const pending = i.pendingMerge
        if (i.phase === 'pr' && pending) events.push(...(await guarded(i, () => onMerged(i, pending.facts, now))))
      }

      // Releases: a few reads per item, in turn.
      for (const i of [...items.values()]) {
        if (stopped) return
        const rel = i.rel
        if (i.phase !== 'release' || !rel) continue
        events.push(
          ...(await guarded(i, async () => {
            const step = await advance(gh, rel, now, config.timeoutMs, config.registry)
            if (items.get(i.id) !== i || stopped) return []
            i.rel = step.rel
            i.release = viewOf(step.rel)
            if (step.rel.runId !== undefined) dropDuplicateRuns(i, step.rel.runId)
            if (step.done) return finishRelease(i, step.done, now)
            touch(i, now)
            return []
          })),
        )
      }

      if (slowTick && config.sweepRepos.length > 0) await sweep(now)

      // Expire offers; forget what's long done.
      for (const i of [...items.values()]) {
        if (i.deploy?.state === 'offered' && now - (i.doneAt ?? now) >= OFFER_TTL_MS) {
          i.deploy = { ...i.deploy, state: 'dismissed' }
          touch(i, now)
        }
      }
      const kept = new Set(prune([...items.values()], now))
      for (const i of [...items.values()]) if (!kept.has(i)) items.delete(i.id)
    } finally {
      isPolling = false
    }
    if (stopped) return
    emit(events)
    if (pollAgain) {
      pollAgain = false
      host.after(0, () => void poll().catch(() => undefined))
    }
    stopTimerIfIdle(now)
  }

  /** One item's poll work: a throw (a corrupt stored item) costs that item a read, never the others' emits. */
  async function guarded(i: Internal, work: () => Promise<MonitorEvent[]>): Promise<MonitorEvent[]> {
    try {
      return await work()
    } catch {
      i.errorStreak++
      return []
    }
  }

  /** A PR-less watch on the same run as a PR's release gives way. */
  function dropDuplicateRuns(keep: Internal, runId: number) {
    for (const i of [...items.values()]) {
      if (i === keep || i.phase !== 'release' || i.pr !== undefined || !sameRepo(i.repo, keep.repo)) continue
      if (keep.pr !== undefined && i.rel?.runId === runId) items.delete(i.id)
    }
  }

  async function sweep(now: number) {
    for (const repo of config.sweepRepos) {
      const wf = await releaseWorkflow(repo, now)
      if (!wf) continue
      const runs = await gh.activeRuns(repo)
      for (const run of runs ?? []) {
        if (!isReleaseRun(run, wf)) continue
        const watched = [...items.values()].some(i => i.rel?.runId === run.id && sameRepo(i.repo, repo))
        if (!watched) await addRelease(repo, 'sweep', wf, now, { run })
      }
    }
  }

  // ── public API ──

  async function boot(): Promise<void> {
    booted ??= (async () => {
      await load().catch(() => undefined)
      if (stopped) return
      if (items.size > 0) {
        emit([])
        if (needsTimer(lastNow)) poke()
      }
    })()
    return booted
  }

  async function beforeTool(seen: Omit<ToolSeen, 'result'>): Promise<void> {
    if (stopped || seen.tool !== 'Bash' || !seen.command) return
    const merge = parsePrCommands(seen.command).find(c => c.verb === 'merge' && c.selector === undefined)
    if (!merge) return
    // Read the branch's PR before a --delete-branch merge switches branches; bounded to one gh call.
    const cwd = await resolveDir(merge.cwd)
    const pending = gh
      .prView(undefined, merge.repo, cwd)
      .then(found => (found ? { repo: found.repo, pr: found.pr } : undefined))
      .catch(() => undefined)
    preResolved.set(seen.command, pending)
    await pending
  }

  function afterTool(seen: ToolSeen): void {
    if (stopped) return
    void (async () => {
      const command = seen.command ?? ''
      const pre = preResolved.get(command)
      preResolved.delete(command)
      if (!command) return
      if (seen.tool === 'Bash') {
        if (!isWorthReading(seen.result)) return
        const reqs = [...bashPrRequests(command, seen.result), ...parseReleaseCommands(command)]
        await armAll(reqs, pre ? await pre : undefined)
      } else if (seen.tool === 'Monitor') {
        if (!isCompleted(seen.result)) return
        const taskId = taskIdOf(seen.result)
        const ci = parseCiWatchCommand(command)
        if (ci) {
          const reqs = ciWatchRequests(ci)
          if (taskId) {
            const repos = reqs.flatMap(r => ('repo' in r && r.repo ? [r.repo] : []))
            const base = ci.defaultRepo ?? (reqs.some(r => !('repo' in r) || !r.repo) ? await repoAt(ci.cwd) : undefined)
            monitorRepos.set(taskId, base ? [...repos, base] : repos)
          }
          await armAll(reqs)
        }
        const rw = parseReleaseWatchCommand(command)
        if (rw) await armAll(rw)
      }
    })().catch(() => undefined)
  }

  function onPrompt(text: string, originKind: string): void {
    if (stopped || !text) return
    void (async () => {
      if (originKind === 'task-notification') {
        await onNotification(text)
      } else if (originKind === 'composer' || originKind === 'bridge') {
        await onTypedMerged(text)
      }
    })().catch(() => undefined)
  }

  /** Route 2: `MERGED` lines poke the PR they name (polling stays the source of truth). */
  async function onNotification(text: string) {
    const lines = mergedLinesIn(text)
    if (lines.length === 0) return
    const now = await host.now()
    lastNow = now
    let poked = false
    const taskRepos = [...monitorRepos.entries()].filter(([id]) => text.includes(id)).flatMap(([, r]) => r)
    for (const line of lines) {
      let target: Internal | undefined
      if (line.repo) {
        target = addPr(line.repo, line.pr, 'merged-event', now)
      } else {
        const tracked = [...items.values()].filter(i => i.pr === line.pr && i.phase === 'pr')
        const byTask = tracked.filter(i => taskRepos.some(r => sameRepo(r, i.repo)))
        target = byTask.length === 1 ? byTask[0] : tracked.length === 1 ? tracked[0] : undefined
      }
      if (target && target.phase === 'pr') {
        target.suspect = true
        target.touchedAt = now
        poked = true
      }
    }
    if (poked) poke()
  }

  /** Route 3: the person says "merged". */
  async function onTypedMerged(text: string) {
    const said = typedMerged(text)
    if (!said.matched) return
    const now = await host.now()
    lastNow = now
    let target: Internal | undefined
    if (said.pr !== undefined) {
      const repo =
        said.repo ??
        [...items.values()].find(i => i.pr === said.pr && i.phase === 'pr')?.repo ??
        (await repoAt(undefined))
      if (repo) target = addPr(repo, said.pr, 'typed-merged', now, undefined, true)
    } else {
      const open = [...items.values()].filter(i => i.phase === 'pr' && i.pr !== undefined)
      open.sort((a, b) => b.touchedAt - a.touchedAt)
      target = open[0]
      if (!target) {
        const repo = await repoAt(undefined)
        const last = repo ? await gh.lastMerged(repo) : undefined
        const known = repo && last ? items.get(prId(repo, last.pr)) : undefined
        // A PR already followed to the end is not followed again.
        if (repo && last && !known && now - last.mergedAt <= RECENT_MERGE_MS && last.mergedAt - now <= CLOCK_SKEW_MS) {
          target = addPr(repo, last.pr, 'typed-merged', now)
        }
      }
    }
    if (!target || target.phase !== 'pr') return
    target.suspect = true
    target.touchedAt = now
    emit([])
    poke()
  }

  async function confirmNow(targets: Internal[], now: number): Promise<Map<Internal, 'gone' | 'ok' | 'unknown'>> {
    const out = new Map<Internal, 'gone' | 'ok' | 'unknown'>()
    const fresh = targets.filter(i => i.phase === 'pr')
    if (fresh.length === 0) return out
    const found = await gh.prs(fresh.map(i => ({ repo: i.repo, pr: i.pr as number })))
    const events: MonitorEvent[] = []
    for (const [k, i] of fresh.entries()) {
      const l = found[k]
      if (l && 'gone' in l) {
        items.delete(i.id)
        out.set(i, 'gone')
        continue
      }
      events.push(...(await applyPr(i, l, now)))
      out.set(i, l && 'node' in l ? 'ok' : 'unknown')
    }
    emit(events)
    // Already read: just keep the timer; a release just armed gets its first look now.
    if ([...out.keys()].some(i => i.phase === 'release')) poke()
    else ensureTimer()
    return out
  }

  async function watchPr(args: string): Promise<string> {
    const { targets, bad } = parseWatchPrArgs(args)
    if (targets.length === 0) return bad.length ? `not found: ${bad.join(' ')}`.slice(0, 80) : 'usage: /watch-pr <N | owner/repo#N | URL>'
    const now = await host.now()
    lastNow = now
    const armed: Internal[] = []
    const notFound = [...bad]
    for (const t of targets) {
      const repo = t.repo ?? (await repoAt(undefined))
      if (!repo) {
        notFound.push(`#${t.pr}`)
        continue
      }
      const i = addPr(repo, t.pr, 'command', now, undefined, true)
      if (i.confirmed) i.touchedAt = now
      armed.push(i)
    }
    const result = await confirmNow(armed.filter(i => !i.confirmed), now)
    for (const [i, r] of result) if (r === 'gone') notFound.push(`${nameOf(i.repo)} #${i.pr}`)
    const watching = armed.filter(i => result.get(i) !== 'gone')
    const parts: string[] = []
    if (watching.length > 0) parts.push(`watching ${watching.map(i => `${nameOf(i.repo)} #${i.pr}`).join(', ')}`)
    if (notFound.length > 0) parts.push(`not found: ${notFound.join(' ')}`)
    return elide(parts.join('; '), 80)
  }

  async function watchRelease(args: string): Promise<string> {
    const parsed = parseWatchReleaseArgs(args)
    if (!parsed) return 'usage: /watch-release <owner/repo> [--pr N | --tag vX]'
    const now = await host.now()
    lastNow = now
    const name = nameOf(parsed.repo)
    if (parsed.pr !== undefined) {
      const i = addPr(parsed.repo, parsed.pr, 'command', now, undefined, true)
      if (!i.confirmed) {
        const r = await confirmNow([i], now)
        if (r.get(i) === 'gone') return elide(`not found: ${name} #${parsed.pr}`, 80)
      }
      return elide(`watching ${name} #${parsed.pr}`, 80)
    }
    const wf = await releaseWorkflow(parsed.repo, now)
    if (wf === null) return elide(`not found: ${name} has no release workflow`, 80)
    if (wf === undefined) return elide(`not found: couldn't read ${name}`, 80)
    const i = await armRepoRelease(parsed.repo, 'command', wf, now, false, parsed.tag)
    if (!i) return elide(`watching ${name} releases`, 80) // an existing watch covers it
    emit([])
    poke()
    return elide(parsed.tag ? `watching ${name} ${parsed.tag}` : `watching ${name} releases`, 80)
  }

  function stop(id: ItemId | 'all'): void {
    if (id === 'all') items.clear()
    else items.delete(id)
    emit([])
    stopTimerIfIdle(lastNow)
  }

  function setDeploy(id: ItemId, state: 'filled' | 'dismissed') {
    const i = items.get(id)
    if (!i?.deploy) return
    i.deploy = { ...i.deploy, state }
    touch(i, lastNow)
    emit([])
    stopTimerIfIdle(lastNow)
  }

  function shutdown(): void {
    if (stopped) return
    if (saveTimer) {
      saveTimer.cancel()
      saveTimer = null
      void save().catch(() => undefined)
    }
    stopped = true
    if (timer) {
      timer.cancel()
      timer = null
    }
  }

  return {
    boot,
    beforeTool,
    afterTool,
    onPrompt,
    watchPr,
    watchRelease,
    stop,
    deployFilled: id => setDeploy(id, 'filled'),
    deployDismissed: id => setDeploy(id, 'dismissed'),
    snapshot: () => snapshotAt(lastNow),
    subscribe: fn => void subscribers.push(fn),
    takeNudges: () => nudges.splice(0),
    shutdown,
  }
}

function elide(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`
}
