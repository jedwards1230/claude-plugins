import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { answer, cutRelease, github, pushImage, REPO } from './fixtures/github'
import type { GitHub } from './fixtures/github'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const SESSION_END = { reason: 'other', sessionId: 's1', resume: 's1' } as never
const POLL = 30_000
const MERGE = `gh pr merge 12 --squash --delete-branch --repo ${REPO}`
const BASH_OK = { result: { stdout: '✓ Squashed and merged pull request #12', stderr: '', interrupted: false } }

/** The plugin loaded over a scripted GitHub; keeps every gh run, status line and toast. */
function world(on: On, gh: GitHub, toolAnswer: unknown = BASH_OK) {
  const runs: string[] = []
  /** Each gh run's init (`cwd`, `timeoutMs`), in run order. */
  const inits: { cwd?: string; timeoutMs?: number }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  /**
   * Set `deny` to make every process.run reject, `denyOn` to reject the runs whose
   * argv contains it; `lag` answers each run that many ticks late.
   */
  const ctl: { deny: boolean; denyOn: string | null; lag: number } = { deny: false, denyOn: null, lag: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('process.run', async ($, e) => {
    runs.push(e.argv.join(' '))
    inits.push({ ...(e.init ?? {}) })
    for (let i = 0; i < ctl.lag; i++) await Promise.resolve()
    if (ctl.deny || (ctl.denyOn !== null && e.argv.join(' ').includes(ctl.denyOn))) return { deny: 'x' }
    return { value: answer(gh, e.argv) }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => (typeof toolAnswer === 'function' ? toolAnswer() : toolAnswer) as never)
  const clock = mock.clock(on)
  return { runs, inits, ctl, statuses, toasts, clock }
}

async function mergeIn($: Engine, clock: { settle: () => Promise<void> }, command = MERGE) {
  await $.session.start(SESSION)
  const result = await $.tool.call({ tool: 'Bash', command })
  await clock.settle()
  return result
}

describe('release-ticker register', () => {
  test('a merged PR walks run -> tag -> release -> digest, toasts the version, clears the status', async ($, on) => {
    const gh = github({ pkg: 'users' })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    expect(w.statuses).toEqual([`release ${REPO} #12: waiting for release.yml run`])

    gh.run = { status: 'in_progress', conclusion: null }
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1)).toBe(`release ${REPO} #12: run in_progress → tag`)

    gh.run = { status: 'completed', conclusion: 'success' }
    cutRelease(gh)
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1), 'tag and release land in one poll; the digest is next').toBe(
      `release ${REPO} #12: release v1.2.3 → ghcr.io digest`,
    )
    expect(w.toasts).toEqual([])

    pushImage(gh)
    await w.clock.advance(POLL)
    expect(w.toasts).toEqual([`${REPO} v1.2.3 published (ghcr.io sha256:dddddddddddd)`])
    expect(w.statuses.at(-1), 'the status is gone once published').toBeUndefined()

    const polled = w.runs.length
    await w.clock.advance(5 * POLL)
    expect(w.runs.length, 'disarmed: no more polling').toBe(polled)
  })

  test('the walk stops at the tag stage when the run already finished', async ($, on) => {
    const gh = github({ run: { status: 'completed', conclusion: 'success' } })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1)).toBe(`release ${REPO} #12: run success → tag`)

    cutRelease(gh)
    await w.clock.advance(POLL)
    expect(w.toasts, 'no package: published at the Release').toEqual([`${REPO} v1.2.3 published`])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a failed release run toasts the failure and clears the status', async ($, on) => {
    const gh = github({ run: { status: 'in_progress', conclusion: null } })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(POLL)
    gh.run = { status: 'completed', conclusion: 'failure' }
    await w.clock.advance(POLL)

    expect(w.toasts).toEqual([`${REPO}: release run failed (failure)`])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a release that never resolves times out at timeoutMin (20 min by default)', async ($, on) => {
    const gh = github({ run: { status: 'in_progress', conclusion: null } })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(19 * 60_000)
    expect(w.toasts).toEqual([])
    expect(w.statuses.at(-1)).toBe(`release ${REPO} #12: run in_progress → tag`)

    await w.clock.advance(60_000 + POLL)
    expect(w.toasts).toEqual([`${REPO}: release watch timed out after 20 min`])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a repo with no release workflow stays silent: no status, no toast', async ($, on) => {
    const gh = github({ hasWorkflow: false })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(30 * 60_000)
    await $.session.end(SESSION_END)

    expect(w.statuses).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.runs.some(r => r.includes('/runs?')), 'never polled').toBe(false)
  })

  test('a merge with no release run gives up quietly after the grace window', async ($, on) => {
    const gh = github()
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(4 * 60_000)

    expect(w.toasts).toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a failed gh pr merge arms nothing', async ($, on) => {
    const errored = { isError: true, result: 'Exit code 1', text: 'Pull request is not mergeable' }
    const w = world(on, github(), errored)

    const result = await mergeIn($, w.clock)
    await w.clock.advance(5 * POLL)

    expect(result).toEqual(errored)
    expect(w.runs).toEqual([])
    expect(w.statuses).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a denied gh pr merge arms nothing', async ($, on) => {
    const w = world(on, github(), { deny: 'not allowed' })

    const result = await mergeIn($, w.clock)
    await w.clock.advance(5 * POLL)

    expect(result).toEqual({ deny: 'not allowed' })
    expect(w.runs).toEqual([])
    expect(w.statuses).toEqual([])
  })

  test('gh pr merge --auto that only enabled auto-merge does not arm', async ($, on) => {
    const gh = github({ prState: 'OPEN' })
    const w = world(on, gh)

    await mergeIn($, w.clock, `gh pr merge 12 --auto --squash --repo ${REPO}`)
    await w.clock.advance(5 * POLL)

    expect(w.runs).toEqual([`gh pr view 12 --repo ${REPO} --json number,url,state,mergedAt,mergeCommit`])
    expect(w.statuses).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a bare gh pr merge reads the current branch PR before merging', async ($, on) => {
    const w = world(on, github())

    await mergeIn($, w.clock, 'gh pr merge --squash')

    expect(w.runs.slice(0, 2)).toEqual([
      'gh pr view --json number,url',
      `gh pr view 12 --repo ${REPO} --json number,url,state,mergedAt,mergeCommit`,
    ])
    expect(w.statuses).toEqual([`release ${REPO} #12: waiting for release.yml run`])
  })

  test('the tool.call result is handed back verbatim', async ($, on) => {
    const w = world(on, github())

    const result = await mergeIn($, w.clock)

    expect(result).toEqual(BASH_OK)
  })

  test('other Bash commands pass through untouched and run no gh', async ($, on) => {
    const w = world(on, github())

    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Bash', command: 'gh pr view 12 && echo gh pr merge' })
    await w.clock.advance(5 * POLL)

    expect(result).toEqual(BASH_OK)
    expect(w.runs).toEqual([])
  })

  test('session.end cancels the watch and clears the status', async ($, on) => {
    const gh = github({ run: { status: 'queued', conclusion: null } })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await $.session.end(SESSION_END)
    const polled = w.runs.length
    await w.clock.advance(5 * POLL)

    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.runs.length).toBe(polled)
    expect(w.toasts).toEqual([])
  })

  test('every gh call is bounded at 15 s or less', async ($, on) => {
    const gh = github({ pkg: 'users', run: { status: 'completed', conclusion: 'success' } })
    const w = world(on, gh)

    await mergeIn($, w.clock, 'gh pr merge --squash')
    cutRelease(gh)
    await w.clock.advance(POLL)
    pushImage(gh)
    await w.clock.advance(POLL)

    expect(w.toasts).toEqual([`${REPO} v1.2.3 published (ghcr.io sha256:dddddddddddd)`])
    expect(w.inits.length).toBeGreaterThan(5)
    for (const init of w.inits) {
      expect(typeof init.timeoutMs, 'every run sets its own timeout').toBe('number')
      expect(init.timeoutMs as number).toBeLessThanOrEqual(15_000)
    }
  })

  test('a gh that rejects during the merge is swallowed: verbatim result, nothing shown', async ($, on) => {
    const w = world(on, github())
    w.ctl.deny = true

    const result = await mergeIn($, w.clock, 'gh pr merge --squash')
    await w.clock.advance(5 * POLL)

    expect(result).toEqual(BASH_OK)
    expect(w.runs.length, 'it did try').toBeGreaterThan(0)
    expect(w.statuses).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a gh that rejects mid-watch is swallowed and the next poll advances', async ($, on) => {
    const gh = github({ run: { status: 'in_progress', conclusion: null } })
    const w = world(on, gh)

    await mergeIn($, w.clock)
    await w.clock.advance(POLL)
    const shown = w.statuses.at(-1)
    expect(shown).toBe(`release ${REPO} #12: run in_progress → tag`)

    w.ctl.deny = true
    gh.run = { status: 'completed', conclusion: 'success' }
    cutRelease(gh)
    await w.clock.advance(POLL)
    expect(w.toasts).toEqual([])
    expect(w.statuses.at(-1)).toBe(shown)

    w.ctl.deny = false
    await w.clock.advance(POLL)
    expect(w.toasts).toEqual([`${REPO} v1.2.3 published`])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('one rejecting gh call costs only its own answer: a package lookup that rejects skips the digest stage', async ($, on) => {
    const gh = github({ pkg: 'users', run: { status: 'completed', conclusion: 'success' } })
    const w = world(on, gh)
    w.ctl.denyOn = '/packages/'

    await mergeIn($, w.clock)
    expect(w.statuses).toEqual([`release ${REPO} #12: waiting for release.yml run`])
    cutRelease(gh)
    await w.clock.advance(POLL)

    expect(w.toasts).toEqual([`${REPO} v1.2.3 published`])
  })

  test('cd dir && gh pr merge runs gh pr view in that dir (relative dirs are left to the session cwd)', async ($, on) => {
    const w = world(on, github())

    await mergeIn($, w.clock, 'cd /src/widget && gh pr merge 12 --squash')
    const view = w.runs.findIndex(r => r.startsWith('gh pr view 12'))
    expect(view).toBeGreaterThanOrEqual(0)
    expect(w.inits[view]?.cwd).toBe('/src/widget')

    await mergeIn($, w.clock, 'cd widget && gh pr merge 12 --squash')
    const views = w.runs.flatMap((r, i) => (r.startsWith('gh pr view 12') ? [i] : []))
    expect(w.inits[views.at(-1) as number]?.cwd).toBe('widget')
  })

  test('a bare merge with --delete-branch still arms the PR it merged', async ($, on) => {
    const gh = github()
    const w = world(on, gh, () => {
      // The merge switched off the PR branch: the current branch has no PR any more.
      gh.currentBranchPr = false
      return BASH_OK
    })
    // gh answers a beat late, so a lookup still in flight when the merge runs reads the post-merge branch.
    w.ctl.lag = 5

    await mergeIn($, w.clock, 'gh pr merge --squash --delete-branch')

    expect(w.statuses).toEqual([`release ${REPO} #12: waiting for release.yml run`])
  })

  test('a bare merge whose output is redirected (2>&1) still arms', async ($, on) => {
    const w = world(on, github())

    await mergeIn($, w.clock, 'gh pr merge --squash 2>&1')

    expect(w.statuses).toEqual([`release ${REPO} #12: waiting for release.yml run`])
  })
})
