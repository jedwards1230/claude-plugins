import { describe, expect, test } from 'claude-code/testing'

import { configOf, POLL_MS } from '../hooks/release-ticker/logic'
import type { Config } from '../hooks/release-ticker/logic'
import { createTicker } from '../hooks/release-ticker/ticker'
import type { Host } from '../hooks/release-ticker/ticker'
import { answer, cutRelease, github, MERGE_SHA, OLD_SHA, PR, pushImage, RELEASE_SHA, REPO } from './fixtures/github'

const iso = (ms: number) => new Date(ms).toISOString()
const LATER_SHA = 'f'.repeat(40)
import type { GitHub } from './fixtures/github'

/**
 * The ticker over a scripted Host: options the plugin under `claude plugin
 * test` can't be given (floatingTagRepos, a shorter timeout) are tested here.
 */
function rig(gh: GitHub, options: Record<string, unknown> = {}, onRun?: (line: string) => void) {
  let now = 0
  const statuses: (string | undefined)[] = []
  const toasts: { text: string; timeoutMs?: number }[] = []
  const runs: string[] = []
  let timers = 0
  const host: Host = {
    run: async argv => {
      runs.push(argv.join(' '))
      onRun?.(argv.join(' '))
      return answer(gh, argv)
    },
    now: async () => now,
    every: () => {
      timers += 1
      return { cancel: () => (timers -= 1) }
    },
    status: text => statuses.push(text),
    toast: (text, timeoutMs) => toasts.push({ text, ...(timeoutMs ? { timeoutMs } : {}) }),
  }
  const config: Config = configOf(options)
  const ticker = createTicker(host, config)
  return {
    ticker,
    statuses,
    toasts,
    runs,
    texts: () => toasts.map(t => t.text),
    timers: () => timers,
    /** Sets the clock without polling. */
    at: (ms: number) => {
      now = ms
    },
    /** Moves the clock one poll and polls, as the 30 s timer does. */
    tick: async (ms = POLL_MS) => {
      now += ms
      await ticker.poll()
    },
  }
}

const MERGED = { repo: REPO, pr: String(PR), auto: false }
const FLOATING = { floatingTagRepos: [`${REPO}:v1`] }
const NAG = `${REPO} #${PR}: floating tag v1 not moved — dispatch release.yml to move it`
const PUBLISHED = `${REPO} #${PR}: v1.2.3 published (GitHub release)`

describe('release-ticker ticker', () => {
  test('floating tag left on the old commit after a release: nag', async () => {
    const gh = github({ floating: { v1: OLD_SHA } })
    const r = rig(gh, FLOATING)

    await r.ticker.arm(MERGED)
    gh.run = { status: 'completed', conclusion: 'success' }
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED, NAG])
    expect(r.toasts[1]?.timeoutMs, 'the nag stays up longer').toBe(10_000)
  })

  test('floating tag moved to the release commit: no nag', async () => {
    const gh = github({ floating: { v1: RELEASE_SHA } })
    const r = rig(gh, FLOATING)

    await r.ticker.arm(MERGED)
    gh.run = { status: 'completed', conclusion: 'success' }
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('floating-tag repo with no dispatched run: status hints, timeout nags', async () => {
    const gh = github({ floating: { v1: OLD_SHA } })
    const r = rig(gh, { ...FLOATING, timeoutMin: 5 })

    await r.ticker.arm(MERGED)
    expect(r.statuses).toEqual([
      `widget #${PR} · 1/3 · dispatch release.yml to move v1`,
    ])

    for (let i = 0; i < 9; i++) await r.tick()
    expect(r.texts(), 'no quiet give-up for a floating-tag repo').toEqual([])

    await r.tick()
    expect(r.texts()).toEqual([`${REPO} #${PR}: still waiting for the workflow after 5 min — gave up`, NAG])
    expect(r.statuses.at(-1)).toBeUndefined()
  })

  test('floating-tag repo with no release: the tag on the merge commit is enough', async () => {
    const gh = github({ floating: { v1: MERGE_SHA }, run: { status: 'completed', conclusion: 'skipped' } })
    const r = rig(gh, FLOATING)

    await r.ticker.arm(MERGED)
    await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: release.yml ran but cut no new version (nothing to release)`])
  })

  test('a failed run does not nag on top of the failure', async () => {
    const gh = github({ floating: { v1: OLD_SHA }, run: { status: 'completed', conclusion: 'failure' } })
    const r = rig(gh, FLOATING)

    await r.ticker.arm(MERGED)
    await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: release.yml failed (failure)`])
  })

  test('an unreadable floating tag never nags', async () => {
    const gh = github({ floating: {}, run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh, FLOATING)

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('an org package is found under orgs/ and its digest awaited', async () => {
    const gh = github({ pkg: 'orgs', run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()
    expect(r.texts()).toEqual([])
    pushImage(gh)
    await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: v1.2.3 published (GitHub release + ghcr.io image sha256:dddddddddddd)`])
  })

  test('a registry that cannot be queried skips the digest stage', async () => {
    const gh = github({ pkg: 'users', run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    gh.broken = ['/versions']
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: v1.2.3 published (GitHub release; ghcr.io image not checked)`])
  })

  test('a registry other than ghcr.io never looks up a package', async () => {
    const gh = github({ pkg: 'users', run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh, { registry: 'registry.example.com' })

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()

    expect(r.runs.some(x => x.includes('/packages/'))).toBe(false)
    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('a transient API failure keeps the watch where it was', async () => {
    const gh = github({ run: { status: 'in_progress', conclusion: null } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    await r.tick()
    gh.broken = ['/runs?']
    await r.tick()

    expect(r.ticker.watches()[0]?.runStatus).toBe('in_progress')
    expect(r.texts()).toEqual([])
  })

  test('a tag with no GitHub Release ends as tagged after the grace window', async () => {
    const gh = github({ run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    gh.tags = [{ name: 'v1.2.3', sha: RELEASE_SHA }, ...gh.tags]
    await r.tick()
    expect(r.texts()).toEqual([])
    for (let i = 0; i < 4; i++) await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: tagged v1.2.3, but no GitHub release appeared`])
  })

  test('a second merge in the same repo replaces the first watch; one timer serves all', async () => {
    const gh = github()
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    await r.ticker.arm(MERGED)
    expect(r.ticker.watches().length).toBe(1)
    expect(r.timers()).toBe(1)
  })

  test('the timer is cancelled once the last watch ends', async () => {
    const gh = github({ run: { status: 'completed', conclusion: 'failure' } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    expect(r.timers()).toBe(1)
    await r.tick()
    expect(r.timers()).toBe(0)
  })

  test('stop clears a shown status and stays quiet when nothing was shown', async () => {
    const shown = rig(github())
    await shown.ticker.arm(MERGED)
    shown.ticker.stop()
    expect(shown.statuses.at(-1)).toBeUndefined()
    expect(shown.timers()).toBe(0)

    const idle = rig(github())
    idle.ticker.stop()
    expect(idle.statuses).toEqual([])
  })

  test('a registry digest that never shows ends as published at the timeout, not timed out', async () => {
    const gh = github({ pkg: 'users', run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh, { timeoutMin: 5 })

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()
    expect(r.ticker.watches()[0]?.stage).toBe('registry')
    for (let i = 0; i < 9; i++) await r.tick()

    expect(r.texts()).toEqual([`${REPO} #${PR}: v1.2.3 published (GitHub release; no ghcr.io image after 5 min)`])
    expect(r.statuses.at(-1)).toBeUndefined()
  })

  test('the new tag is found past 100 older tags', async () => {
    const old = Array.from({ length: 150 }, (_, i) => ({ name: `z-old-${i}`, sha: OLD_SHA }))
    const gh = github({ tags: [...old, { name: 'v1.2.2', sha: OLD_SHA }], run: { status: 'completed', conclusion: 'success' } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('an unrelated new tag is not taken for the release', async () => {
    const gh = github({ run: { status: 'completed', conclusion: 'success' }, releases: ['v1.2.2', 'nightly'] })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    gh.tags = [{ name: 'nightly', sha: LATER_SHA }, ...gh.tags]
    await r.tick()
    expect(r.texts(), 'a tag off the merge history is ignored').toEqual([])
    expect(r.ticker.watches()[0]?.stage).toBe('tag')

    cutRelease(gh)
    await r.tick()
    expect(r.texts()).toEqual([PUBLISHED])
    expect(r.runs.filter(x => x.includes(`/compare/${MERGE_SHA}...${LATER_SHA}`)).length, 'checked once').toBe(1)
  })

  test('a PR merged long before the merge command does not arm', async () => {
    const gh = github({ mergedAt: iso(0) })
    const r = rig(gh)

    r.at(10 * 60_000)
    await r.ticker.arm(MERGED)
    expect(r.ticker.watches()).toEqual([])
    expect(r.statuses).toEqual([])

    r.at(4 * 60_000)
    await r.ticker.arm(MERGED)
    expect(r.ticker.watches().length, 'merged within 5 min: armed').toBe(1)
  })

  test('stop while the floating tag is being read: no nag after stop', async () => {
    const gh = github({ floating: { v1: OLD_SHA }, run: { status: 'completed', conclusion: 'success' } })
    let stop = () => {}
    const r = rig(gh, FLOATING, line => {
      if (line.includes('/commits/')) stop()
    })
    stop = () => r.ticker.stop()

    await r.ticker.arm(MERGED)
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('floating-tag repo: a run dispatched after the merge on a later head is followed', async () => {
    const gh = github({ floating: { v1: RELEASE_SHA }, mergedAt: iso(30_000) })
    const r = rig(gh, FLOATING)

    r.at(60_000)
    await r.ticker.arm(MERGED)
    gh.dispatchRuns = [{ head_sha: OLD_SHA, status: 'completed', conclusion: 'failure', created_at: iso(0) }]
    await r.tick()
    expect(r.texts(), 'a run dispatched before the merge is not ours').toEqual([])

    gh.dispatchRuns = [
      { head_sha: LATER_SHA, status: 'completed', conclusion: 'success', created_at: iso(120_000) },
      ...gh.dispatchRuns,
    ]
    gh.ancestry[LATER_SHA] = 'ahead'
    cutRelease(gh)
    await r.tick()

    expect(r.texts()).toEqual([PUBLISHED])
  })

  test('deck#32 regression: release.yml succeeds but cuts no tag (a chore merge) -> no-release well before the timeout', async () => {
    const gh = github({ run: { status: 'in_progress', conclusion: null } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    await r.tick()
    gh.run = { status: 'completed', conclusion: 'success' }
    await r.tick()
    expect(r.statuses.at(-1)).toBe(`widget #${PR} · 2/3 · workflow done, waiting for tag`)

    let elapsed = 2 * POLL_MS
    while (r.ticker.watches().length > 0 && elapsed < 20 * 60_000) {
      await r.tick()
      elapsed += POLL_MS
    }
    expect(r.texts()).toEqual([`${REPO} #${PR}: release.yml ran but cut no new version (nothing to release)`])
    expect(r.statuses.at(-1), 'the status line is gone').toBeUndefined()
    expect(elapsed, 'ends within ~90 s of the run finishing, not at the 20 min timeout').toBeLessThanOrEqual(3 * 60_000)
  })

  test('the running phrase counts from the run start GitHub reports', async () => {
    const gh = github({ run: { status: 'in_progress', conclusion: null, run_started_at: iso(-60_000) } })
    const r = rig(gh)

    await r.ticker.arm(MERGED)
    await r.tick()
    expect(r.statuses.at(-1)).toBe(`widget #${PR} · 1/3 · workflow running 1m 30s`)
  })
})
