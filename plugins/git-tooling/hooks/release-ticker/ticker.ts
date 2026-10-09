/**
 * Release Ticker — the watcher. Arms on a confirmed merge, polls every
 * POLL_MS through bounded `gh` calls, keeps one status line for every armed
 * watch, toasts each terminal outcome. Everything it touches goes through a
 * Host, so tests drive it with a scripted one; register.ts builds the real
 * Host over `$`.
 */
import {
  checksFloatingTag,
  floatingTagFor,
  isFloatingTagStale,
  isRecentMerge,
  nagTextOf,
  POLL_MS,
  stepRegistry,
  stepRelease,
  stepRun,
  stepTag,
  statusLineOf,
  timeoutOf,
  toastTextOf,
} from './logic'
import type {
  Config,
  MergeCommand,
  Package,
  ReleaseObs,
  RunObs,
  Step,
  TagObs,
  Terminal,
  VersionObs,
  Watch,
} from './logic'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Host = {
  /** Runs a command, bounded; null when it could not start or timed out. */
  run: (argv: readonly string[], cwd?: string) => Promise<RunResult | null>
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  status: (text: string | undefined) => void
  toast: (text: string, timeoutMs?: number) => void
}

/** A PR resolved before the merge ran (for a bare `gh pr merge` on the current branch). */
export type PreResolved = Promise<{ number: number; repo: string } | undefined>

export type Ticker = {
  /** Starts resolving the current branch's PR, before the merge can switch branches. */
  preResolve: (merge: MergeCommand) => PreResolved
  /** Arms a watch for a merge that ran; does nothing unless it really merged into a releasing repo. */
  arm: (merge: MergeCommand, pre?: PreResolved) => Promise<void>
  /** One poll of every armed watch. */
  poll: () => Promise<void>
  /** Drops every watch, cancels the timer, clears the status. */
  stop: () => void
  /** The armed watches, for tests. */
  watches: () => Watch[]
}

/** How long a toast that nags stays up. */
const NAG_TOAST_MS = 10_000

/**
 * The newest tags by commit date. The REST tag list is one page sorted by
 * name, not by age, so a busy repo's new tag can be missing from it.
 */
const TAGS_QUERY =
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){' +
  'refs(refPrefix:"refs/tags/",first:20,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){' +
  'nodes{name target{oid ... on Tag{target{oid}}}}}}}'

type Json = { ok: true; data: unknown } | { ok: false; notFound: boolean }

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function repoFromUrl(url: unknown): string | undefined {
  const m = typeof url === 'string' ? /\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url) : null
  return m?.[1]
}

export function createTicker(host: Host, config: Config): Ticker {
  const watches = new Map<string, Watch>()
  let timer: { cancel: () => void } | null = null
  let isPolling = false
  let stopped = false
  /** What the status line shows now; undefined when nothing is pinned. */
  let shown: string | undefined
  /** The clock at the last arm or poll, for the elapsed time in the status line. */
  let lastNow = 0

  async function gh(args: readonly string[], cwd?: string): Promise<RunResult | null> {
    return host.run(['gh', ...args], cwd)
  }

  async function api(path: string): Promise<Json> {
    const r = await gh(['api', path])
    if (!r) return { ok: false, notFound: false }
    if (r.exitCode !== 0) return { ok: false, notFound: /HTTP 404|Not Found/i.test(r.stderr + r.stdout) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, notFound: false }
    }
  }

  /** Pins the status line for the armed watches; skips a no-op redraw. */
  function render() {
    const text = statusLineOf([...watches.values()], config, lastNow)
    if (text === shown) return
    shown = text
    host.status(text)
  }

  function ensureTimer() {
    if (!timer && !stopped) timer = host.every(POLL_MS, () => void poll().catch(() => undefined))
  }

  function stopTimerIfIdle() {
    if (watches.size === 0 && timer) {
      timer.cancel()
      timer = null
    }
  }

  async function preResolve(merge: MergeCommand): PreResolved {
    const r = await gh(['pr', 'view', '--json', 'number,url'], merge.cwd)
    if (!r || r.exitCode !== 0) return undefined
    try {
      const pr = recordOf(JSON.parse(r.stdout))
      const repo = repoFromUrl(pr.url)
      return typeof pr.number === 'number' && repo ? { number: pr.number, repo } : undefined
    } catch {
      return undefined
    }
  }

  async function findPackage(repo: string): Promise<Package | undefined> {
    if (config.registry !== 'ghcr.io') return undefined
    const [owner, name] = repo.split('/') as [string, string]
    for (const scope of ['users', 'orgs'] as const) {
      const r = await api(`${scope}/${owner}/packages/container/${encodeURIComponent(name)}`)
      if (r.ok) return { scope, owner, name }
    }
    return undefined
  }

  async function arm(merge: MergeCommand, pre?: PreResolved): Promise<void> {
    let selector = merge.pr
    let repo = merge.repo
    if (selector === undefined) {
      const resolved = pre ? await pre : undefined
      if (!resolved) return
      selector = String(resolved.number)
      repo = resolved.repo
    }
    const view = await gh(
      ['pr', 'view', selector, ...(repo ? ['--repo', repo] : []), '--json', 'number,url,state,mergedAt,mergeCommit'],
      merge.cwd,
    )
    if (!view || view.exitCode !== 0) return
    let pr: Record<string, unknown>
    try {
      pr = recordOf(JSON.parse(view.stdout))
    } catch {
      return
    }
    const mergeSha = recordOf(pr.mergeCommit).oid
    const prRepo = repoFromUrl(pr.url) ?? repo
    // `--auto` with checks pending, or a merge that failed: nothing merged, nothing to watch.
    if (pr.state !== 'MERGED' || typeof mergeSha !== 'string' || !prRepo || typeof pr.number !== 'number') {
      return
    }
    // A PR that merged a while ago (re-running `gh pr merge` on it) was not merged by this call.
    if (!isRecentMerge(pr.mergedAt, await host.now())) return

    // No release workflow -> fall through quietly: no status, no toast.
    const workflow = await api(`repos/${prRepo}/actions/workflows/${encodeURIComponent(config.releaseWorkflow)}`)
    if (!workflow.ok) return

    const tags = await newestTags(prRepo)
    if (!tags) return
    const baselineTags = tags.map(t => t.name)

    const pkg = await findPackage(prRepo)
    const floatingTag = floatingTagFor(config, prRepo)
    if (stopped) return
    const now = await host.now()
    lastNow = now
    const watch: Watch = {
      repo: prRepo,
      pr: pr.number,
      mergeSha,
      mergedAt: Date.parse(pr.mergedAt as string),
      armedAt: now,
      deadline: now + config.timeoutMs,
      stage: 'run',
      baselineTags,
      ...(pkg ? { pkg } : {}),
      ...(floatingTag ? { floatingTag } : {}),
    }
    // One watch per repo: a newer merge replaces the older one.
    watches.set(prRepo.toLowerCase(), watch)
    render()
    ensureTimer()
  }

  function runOf(value: unknown): RunObs | null {
    const run = recordOf(value)
    if (typeof run.status !== 'string') return null
    const startedAt = Date.parse(String(run.run_started_at ?? run.created_at))
    return {
      status: run.status,
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    }
  }

  /**
   * The release run for the merge commit. A floating-tag repo releases on a
   * dispatch, whose head is wherever the default branch is by then (another
   * merge may have landed), so for it a run dispatched after the merge counts too.
   */
  async function observeRun(w: Watch): Promise<RunObs | null | undefined> {
    const runs = `repos/${w.repo}/actions/workflows/${encodeURIComponent(config.releaseWorkflow)}/runs`
    const r = await api(`${runs}?head_sha=${w.mergeSha}&per_page=1`)
    if (!r.ok) return undefined
    const list = recordOf(r.data).workflow_runs
    const run = Array.isArray(list) ? runOf(list[0]) : null
    if (run || !w.floatingTag) return run

    const d = await api(`${runs}?event=workflow_dispatch&per_page=5`)
    if (!d.ok) return undefined
    const dispatched = recordOf(d.data).workflow_runs
    const since = w.mergedAt ?? w.armedAt
    const after = Array.isArray(dispatched)
      ? dispatched.find(x => Date.parse(String(recordOf(x).created_at)) >= since)
      : undefined
    return after ? runOf(after) : null
  }

  /** The repo's newest tags by commit date, each with its commit; undefined when unreadable. */
  async function newestTags(repo: string): Promise<TagObs[] | undefined> {
    const [owner, name] = repo.split('/') as [string, string]
    const r = await gh(['api', 'graphql', '-f', `query=${TAGS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`])
    if (!r || r.exitCode !== 0) return undefined
    let nodes: unknown
    try {
      nodes = recordOf(recordOf(recordOf(recordOf(JSON.parse(r.stdout)).data).repository).refs).nodes
    } catch {
      return undefined
    }
    if (!Array.isArray(nodes)) return undefined
    return nodes.flatMap(n => {
      const o = recordOf(n)
      const target = recordOf(o.target)
      // An annotated tag's target is the tag object; its commit is one level down.
      const sha = recordOf(target.target).oid ?? target.oid
      return typeof o.name === 'string' && typeof sha === 'string' ? [{ name: o.name, sha }] : []
    })
  }

  /** Whether `sha` is the merge commit or descends from it; undefined when the check failed. */
  async function descendsFromMerge(w: Watch, sha: string): Promise<boolean | undefined> {
    if (sha === w.mergeSha) return true
    const r = await api(`repos/${w.repo}/compare/${w.mergeSha}...${sha}`)
    if (!r.ok) return r.notFound ? false : undefined
    const status = recordOf(r.data).status
    return typeof status === 'string' ? status === 'ahead' || status === 'identical' : undefined
  }

  async function observeTags(w: Watch): Promise<TagObs[] | undefined> {
    const tags = await newestTags(w.repo)
    if (!tags) return undefined
    const baseline = new Set(w.baselineTags)
    const out: TagObs[] = []
    for (const t of tags) {
      if (baseline.has(t.name) || t.name === w.floatingTag) {
        out.push(t)
        continue
      }
      const related = await descendsFromMerge(w, t.sha)
      out.push(related === undefined ? t : { ...t, related })
    }
    return out
  }

  async function observeRelease(w: Watch): Promise<ReleaseObs | null | undefined> {
    const r = await api(`repos/${w.repo}/releases/tags/${encodeURIComponent(w.tag as string)}`)
    if (r.ok) return { draft: recordOf(r.data).draft === true }
    return r.notFound ? null : undefined
  }

  async function observeVersions(w: Watch): Promise<VersionObs[] | undefined> {
    const p = w.pkg as Package
    const r = await api(`${p.scope}/${p.owner}/packages/container/${encodeURIComponent(p.name)}/versions?per_page=30`)
    if (!r.ok || !Array.isArray(r.data)) return undefined
    return r.data.flatMap(v => {
      const o = recordOf(v)
      const tags = recordOf(recordOf(o.metadata).container).tags
      return typeof o.name === 'string'
        ? [{ digest: o.name, tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [] }]
        : []
    })
  }

  /** Walks one watch as far as this poll's observations allow. */
  async function advance(w: Watch, now: number): Promise<Step> {
    if (now >= w.deadline) return { watch: w, done: timeoutOf(w) }
    let step: Step = { watch: w }
    for (let hops = 0; hops < 4; hops++) {
      const before = step.watch.stage
      const cur = step.watch
      switch (cur.stage) {
        case 'run':
          step = stepRun(cur, await observeRun(cur), now)
          break
        case 'tag':
          step = stepTag(cur, await observeTags(cur), now)
          break
        case 'release':
          step = stepRelease(cur, await observeRelease(cur), now)
          break
        case 'registry':
          step = stepRegistry(cur, await observeVersions(cur))
          break
      }
      if (step.done || step.watch.stage === before) break
    }
    return step
  }

  async function floatingSha(w: Watch): Promise<string | undefined> {
    const r = await api(`repos/${w.repo}/commits/${encodeURIComponent(w.floatingTag as string)}`)
    const sha = r.ok ? recordOf(r.data).sha : undefined
    return typeof sha === 'string' ? sha : undefined
  }

  async function finish(w: Watch, done: Terminal) {
    const text = toastTextOf(w, done, config)
    if (text) host.toast(text)
    if (!checksFloatingTag(w, done)) return
    const sha = await floatingSha(w)
    // The session may have ended while the floating tag was read.
    if (!stopped && isFloatingTagStale(w, sha)) host.toast(nagTextOf(w, config), NAG_TOAST_MS)
  }

  async function poll(): Promise<void> {
    if (isPolling || stopped) return
    isPolling = true
    try {
      for (const [key, w] of [...watches]) {
        const now = await host.now()
        lastNow = now
        const step = await advance(w, now)
        if (stopped || watches.get(key) !== w) continue // replaced or stopped meanwhile
        if (step.done) {
          watches.delete(key)
          render()
          await finish(step.watch, step.done)
        } else {
          watches.set(key, step.watch)
        }
      }
      if (!stopped) render()
    } finally {
      isPolling = false
      stopTimerIfIdle()
    }
  }

  function stop() {
    stopped = true
    watches.clear()
    if (timer) {
      timer.cancel()
      timer = null
    }
    render()
  }

  return { preResolve, arm, poll, stop, watches: () => [...watches.values()] }
}
