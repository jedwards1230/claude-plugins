import { describe, expect, test } from 'claude-code/testing'

import { KEY_PREFIX, MAX_PAYLOAD, payloadOf } from '../hooks/engine/store'
import { engineRig, github, iso, KEY, mergePr, openPr, PR_ID, releaseRun, running } from './fixtures/github'

const OWN = `${KEY_PREFIX}session-1`

describe('persistence', () => {
  test('a new engine over the same store and session resumes every watch where it was', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }), 'acme/widget#13': openPr({ checks: [running('ci')], branch: 'b13' }) } })
    const store = new Map<string, unknown>()
    const a = engineRig(gh, {}, store)
    await a.engine.boot()
    await a.engine.watchPr('12 13')
    releaseRun(gh, { id: 100, status: 'in_progress' })
    await a.engine.watchRelease('acme/gadget')
    await a.tick()
    expect(store.has(OWN)).toBe(true)
    const before = a.engine.snapshot().items.map(i => [i.id, i.phase, i.release?.stage ?? i.prView?.ci])
    a.engine.shutdown()

    const b = engineRig(gh, {}, store)
    b.at(a.now())
    await b.engine.boot()
    await b.settle()
    expect(b.engine.snapshot().items.map(i => [i.id, i.phase, i.release?.stage ?? i.prView?.ci])).toEqual(before)
    expect(b.timers(), 'polling resumes').toBe(1)
    const n = b.runs.length
    await b.tick()
    expect(b.runs.length).toBeGreaterThan(n)
  })

  test('boot is idempotent', async () => {
    const r = engineRig(github())
    await Promise.all([r.engine.boot(), r.engine.boot(), r.engine.boot()])
    expect(r.runs).toEqual([])
  })

  test('items done over an hour ago are not restored; nothing left -> key deleted', async () => {
    const gh = github()
    const store = new Map<string, unknown>()
    const a = engineRig(gh, {}, store)
    await a.engine.watchPr('12')
    mergePr(gh, KEY, { labels: [] }) // ends at once: no release expected
    a.engine.onPrompt('merged', 'composer')
    await a.settle()
    await a.tick()
    expect(a.item(PR_ID)?.phase).toBe('done')
    expect(store.has(OWN)).toBe(true)

    const b = engineRig(gh, {}, store)
    b.at(a.now() + 61 * 60_000)
    await b.engine.boot()
    expect(b.engine.snapshot().items).toEqual([])
  })

  test('another session\'s key: deleted after 7 days, kept before', async () => {
    const store = new Map<string, unknown>([
      [`${KEY_PREFIX}old`, { savedAt: 0, items: [] }],
      [`${KEY_PREFIX}recent`, { savedAt: 7 * 24 * 60 * 60_000, items: [] }],
      ['someone-else', { savedAt: 0 }],
    ])
    const r = engineRig(github(), {}, store)
    r.at(8 * 24 * 60 * 60_000)
    await r.engine.boot()
    expect([...store.keys()].sort()).toEqual([`${KEY_PREFIX}recent`, 'someone-else'])
  })

  test('/clear: the next save goes under the new session id and the old key is deleted', async () => {
    const store = new Map<string, unknown>()
    const r = engineRig(github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } }), {}, store)
    await r.engine.boot()
    await r.engine.watchPr('12')
    await r.tick()
    expect(store.has(OWN)).toBe(true)
    r.ctl.sessionId = 'session-2'
    await r.tick()
    await r.tick() // saves are debounced: the next one lands within two polls
    expect([...store.keys()]).toEqual([`${KEY_PREFIX}session-2`])
  })

  test('the payload stays under 256 KiB, dropping the oldest done items first', () => {
    const big = 'x'.repeat(4_000)
    const items = Array.from({ length: 100 }, (_, n) => ({ phase: n < 90 ? 'done' : 'pr', doneAt: n, title: big, n }))
    const p = payloadOf(items, 0)
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(MAX_PAYLOAD)
    expect(p.items.filter(i => i.phase === 'pr')).toHaveLength(10)
    expect(p.items.some(i => i.n === 0), 'oldest done dropped').toBe(false)
    expect(p.items.some(i => i.n === 89), 'newest done kept').toBe(true)
  })

  test('a malformed stored value is ignored', async () => {
    const store = new Map<string, unknown>([[OWN, { items: 'nope' }]])
    const r = engineRig(github(), {}, store)
    await r.engine.boot()
    expect(r.engine.snapshot().items).toEqual([])
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z')
  })
})
