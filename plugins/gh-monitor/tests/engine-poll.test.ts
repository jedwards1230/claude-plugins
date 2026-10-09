import { describe, expect, test } from 'claude-code/testing'

import { MAX_WATCHES } from '../hooks/engine/engine'
import { engineRig, failed, github, KEY, openPr, passed, PR_ID, running } from './fixtures/github'
import type { FixturePr } from './fixtures/github'

const graphql = (runs: readonly string[]) => runs.filter(x => x.includes('...PR')).length

describe('PR phase', () => {
  test('checks starting -> running -> failing (one event) -> passed (one event)', async () => {
    const gh = github()
    const r = engineRig(gh)
    const p = gh.prs[KEY] as FixturePr
    await r.engine.watchPr('12')
    expect(r.item(PR_ID)?.prView?.ci).toBe('starting')

    p.checks = [running('lint'), running('test')]
    await r.tick()
    expect(r.item(PR_ID)?.prView?.ci).toBe('running')
    expect(r.events).toEqual([])

    p.checks = [failed('lint'), running('test')]
    await r.tick()
    p.checks = [failed('lint'), failed('test')]
    for (let i = 0; i < 4; i++) await r.tick() // still failing, re-read on the 4th tick: no second event
    expect(r.kinds()).toEqual(['checks-failed'])
    expect(r.events[0]).toMatchObject({ kind: 'checks-failed', names: ['lint'] })

    p.checks = [passed('lint'), passed('test')]
    for (let i = 0; i < 4; i++) await r.tick() // failing is settled: read every 4th tick
    expect(r.kinds()).toEqual(['checks-failed', 'checks-passed'])
  })

  test('no checks at all: "starting" for 60 s, then none', async () => {
    const r = engineRig(github())
    await r.engine.watchPr('12')
    await r.tick(30_000)
    expect(r.item(PR_ID)?.prView?.ci).toBe('starting')
    await r.tick(30_000)
    expect(r.item(PR_ID)?.prView?.ci).toBe('none')
    expect(r.events).toEqual([])
  })

  test('a new head commit restarts the no-checks grace', async () => {
    const gh = github()
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    await r.tick(60_000)
    expect(r.item(PR_ID)?.prView?.ci).toBe('none')
    ;(gh.prs[KEY] as FixturePr).headSha = '2'.repeat(40)
    for (let i = 0; i < 4; i++) await r.tick() // a quiet PR is read every 4th tick
    expect(r.item(PR_ID)?.prView?.ci).toBe('starting')
  })

  test('changes requested: one event', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [passed('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    ;(gh.prs[KEY] as FixturePr).reviews = ['CHANGES_REQUESTED']
    for (let i = 0; i < 4; i++) await r.tick()
    expect(r.kinds()).toEqual(['changes-requested'])
    expect(r.item(PR_ID)?.prView?.review).toBe('changes')
  })

  test('closed without merging: outcome closed, no release reads', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    ;(gh.prs[KEY] as FixturePr).state = 'CLOSED'
    await r.tick()
    expect(r.kinds()).toEqual(['outcome'])
    expect(r.item(PR_ID)?.outcome).toEqual({ kind: 'closed' })
    expect(r.runs.some(x => x.includes('actions/') || x.includes('refs('))).toBe(false)
  })

  test('a watched PR that disappears: outcome gone', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    gh.prs = {}
    await r.tick()
    expect(r.item(PR_ID)?.outcome).toEqual({ kind: 'gone' })
  })

  test('the Actions fallback when the rollup hides checks', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [null], actionRuns: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    expect(r.item(PR_ID)?.prView?.failing).toEqual(['CI'])
  })

  test('an open PR quiet for 24 h is dropped silently', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [passed('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    await r.tick(24 * 60 * 60_000)
    await r.tick()
    expect(r.item(PR_ID)).toBeUndefined()
    expect(r.events).toEqual([])
  })
})

describe('robustness', () => {
  test('every gh call failing for 5 ticks: no events, errorStreak counts up, then back to 0', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    r.ctl.deny = true
    for (let i = 0; i < 5; i++) await r.tick()
    expect(r.item(PR_ID)?.errorStreak).toBe(5)
    expect(r.item(PR_ID)?.prView?.ci, 'state kept through the outage').toBe('running')
    r.ctl.deny = false
    await r.tick()
    expect(r.item(PR_ID)?.errorStreak).toBe(0)
    expect(r.events).toEqual([])
  })

  test('a 502 is transient; one NOT_FOUND inside a batch of 3 ends only that one', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('a')] }), 'acme/widget#13': openPr({ checks: [running('b')] }), 'acme/gadget#4': openPr({ checks: [running('c')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12 13 acme/gadget#4')
    gh.broken = ['...PR']
    await r.tick()
    expect(r.engine.snapshot().items.every(i => i.errorStreak === 1)).toBe(true)
    gh.broken = []
    delete gh.prs['acme/widget#13']
    await r.tick()
    const byId = Object.fromEntries(r.engine.snapshot().items.map(i => [i.id, i]))
    expect(byId['pr:acme/widget#13']?.outcome).toEqual({ kind: 'gone' })
    expect(byId[PR_ID]?.phase).toBe('pr')
    expect(byId['pr:acme/gadget#4']?.phase).toBe('pr')
  })

  test('30 PRs: one GraphQL call per tick; a 31st drops the longest idle', async () => {
    const prs: Record<string, FixturePr> = {}
    for (let n = 1; n <= MAX_WATCHES + 1; n++) prs[`acme/widget#${n}`] = openPr({ checks: [running('ci')], branch: `b${n}` })
    const gh = github({ prs })
    const r = engineRig(gh)
    const all = Object.keys(prs).map(k => k.split('#')[1]).join(' ')
    await r.engine.watchPr(all)
    expect(r.engine.snapshot().items).toHaveLength(MAX_WATCHES)
    const before = graphql(r.runs)
    await r.tick()
    expect(graphql(r.runs) - before).toBe(1)
  })

  test('quiet PRs (nothing running) are read every 4th tick only', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [passed('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    const before = graphql(r.runs)
    for (let i = 0; i < 8; i++) await r.tick()
    expect(graphql(r.runs) - before).toBe(2)
  })

  test('a lagging tick never overlaps the next: at most one gh call in flight', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    let open!: () => void
    r.ctl.gate = new Promise<void>(res => (open = res))
    await r.tick()
    await r.tick()
    await r.tick()
    delete r.ctl.gate
    open()
    await r.settle()
    expect(r.maxInflight()).toBe(1)
  })

  test('idle: the timer is cancelled and nothing more runs', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    expect(r.timers()).toBe(1)
    ;(gh.prs[KEY] as FixturePr).state = 'CLOSED'
    await r.tick()
    await r.tick(11 * 60_000) // past the done linger
    expect(r.timers()).toBe(0)
    const n = r.runs.length
    await r.tick()
    await r.tick()
    expect(r.runs.length).toBe(n)
  })

  test('stop(id) and stop(all)', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }), 'acme/widget#13': openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12 13')
    r.engine.stop(PR_ID)
    expect(r.engine.snapshot().items.map(i => i.id)).toEqual(['pr:acme/widget#13'])
    r.engine.stop('all')
    expect(r.engine.snapshot().items).toEqual([])
    expect(r.timers()).toBe(0)
  })

  test('shutdown: no more polling', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    r.engine.shutdown()
    const n = r.runs.length
    await r.tick()
    expect(r.runs.length).toBe(n)
    expect(r.timers()).toBe(0)
  })

  test('nudges: none by default; with nudge on, one line per merged / outcome / checks-failed', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const off = engineRig(gh)
    await off.engine.watchPr('12')
    ;(gh.prs[KEY] as FixturePr).checks = [failed('ci')]
    await off.tick()
    expect(off.kinds()).toEqual(['checks-failed'])
    expect(off.engine.takeNudges()).toEqual([])

    const gh2 = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const on = engineRig(gh2, { nudge: 'true' })
    await on.engine.watchPr('12')
    ;(gh2.prs[KEY] as FixturePr).checks = [failed('ci')]
    await on.tick()
    expect(on.engine.takeNudges()).toEqual(['gh-monitor: acme/widget#12 checks failed (ci)'])
    expect(on.engine.takeNudges(), 'drained').toEqual([])
  })
})
