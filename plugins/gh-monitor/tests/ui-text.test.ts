import { describe, expect, test } from 'claude-code/testing'

import type { Item, MonitorEvent, Outcome } from '../hooks/engine/model'
import {
  bandRowCells,
  bandRows,
  deployPrompt,
  elide,
  OVERFLOW_KEY,
  paneBlocks,
  rowText,
  STATUS_MAX,
  statusLine,
  TOAST_MAX,
  toastFor,
  toastsFor,
  width,
} from '../hooks/ui/text'
import type { ToastConfig } from '../hooks/ui/text'
import {
  canonical,
  doneItem,
  item,
  LONG_CHECKS,
  LONG_REPO,
  LONG_VERSION,
  many,
  NOW,
  offerItem,
  prItem,
  releaseItem,
  snap,
} from './fixtures/items'

/**
 * The budgets as literals, never read back from the code under test, so
 * raising STATUS_MAX or TOAST_MAX there fails these tests (design G7: 82
 * columns less the ` ⚠ gh-monitor: ` prefix Claude Code adds itself).
 */
const STATUS_BUDGET = 66
const TOAST_BUDGET = 100

const CONFIG: ToastConfig = { timeoutMs: 20 * 60_000, releaseWorkflow: 'release.yml' }
const WIDE = 10_000
const COLUMNS = [30, 40, 60, 80, 120] as const

/** One row at room to spare: the "full" phrase level, verbatim. */
const row = (i: Item) => rowText(i, NOW, WIDE)

const OUTCOMES: Outcome[] = [
  { kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3', chart: '1.2.3' },
  { kind: 'released', tag: 'v1.2.3' },
  { kind: 'released', tag: 'v1.2.3', missing: ['image'] },
  { kind: 'tagged-only', tag: 'v1.2.3' },
  { kind: 'no-semver-label' },
  { kind: 'not-default-branch', base: 'dev' },
  { kind: 'no-release-workflow', workflow: 'release.yml' },
  { kind: 'no-version-cut', workflow: 'release.yml' },
  { kind: 'no-run', workflow: 'release.yml' },
  { kind: 'failed', workflow: 'release.yml', conclusion: 'failure' },
  { kind: 'timeout', stage: 'tag', minutes: 20 },
  { kind: 'closed' },
  { kind: 'gone' },
]

/** Every phrase row the UI can draw, for the width sweeps. */
function everyRow(repo: string, version: string): Item[] {
  const at = { repo, id: `pr:${repo}#12` }
  const artifacts = { image: { pkg: 'acme/widget' }, chart: { pkg: 'acme/charts/widget' } }
  return [
    prItem({ ci: 'starting', review: 'unknown' }, at),
    prItem({ ci: 'running' }, at),
    prItem({ ci: 'failing', failed: 5, failing: LONG_CHECKS }, at),
    prItem({ ci: 'passed', review: 'approved-ready' }, at),
    prItem({ ci: 'none', review: 'unresolved', unresolved: 2 }, at),
    prItem({ ci: 'skipped', review: 'conflict' }, at),
    prItem({ ci: 'passed', review: 'changes' }, at),
    prItem({ ci: 'running', review: 'behind' }, { ...at, errorStreak: 3 }),
    releaseItem({ runStatus: undefined }, at),
    releaseItem({ runStatus: undefined, floatingTag: 'v1' }, at),
    releaseItem({ runStatus: 'queued' }, at),
    releaseItem({ runStatus: 'in_progress', runStartedAt: NOW - 80_000 }, at),
    releaseItem({ stage: 'tag', step: 2 }, at),
    releaseItem({ stage: 'release', step: 3, tag: version }, at),
    releaseItem({ stage: 'artifacts', step: 4, tag: version, artifacts }, at),
    releaseItem({ stage: 'release', step: 3, tag: version }, { ...at, pr: undefined, id: `rel:${repo}@1` }),
    ...OUTCOMES.map(o =>
      doneItem(o.kind === 'published' || o.kind === 'released' || o.kind === 'tagged-only' ? { ...o, tag: version } : o, at),
    ),
    offerItem({ ...at, deploy: { ...offerItem().deploy!, version } }),
  ]
}

describe('golden strings (design §3.3)', () => {
  test('PR phase rows', () => {
    expect(row(prItem({ ci: 'starting', review: 'unknown' }))).toBe('widget #12 · checks starting · waiting for review')
    expect(row(prItem({ ci: 'running' }))).toBe('widget #12 · checks running 3/7 · waiting for review')
    expect(row(prItem({ ci: 'failing', failing: ['lint', 'test'] }))).toBe(
      'widget #12 · checks failing: lint, test · waiting for review',
    )
    expect(row(prItem({ ci: 'passed', review: 'approved-ready' }))).toBe('widget #12 · checks passed · approved, ready to merge')
    expect(row(prItem({ ci: 'passed', review: 'ready' }))).toBe('widget #12 · checks passed · ready to merge')
    expect(row(prItem({ ci: 'passed', review: 'approved' }))).toBe('widget #12 · checks passed · approved')
    expect(row(prItem({ ci: 'none', review: 'requested' }))).toBe('widget #12 · no checks configured · waiting for review')
    expect(row(prItem({ ci: 'skipped', review: 'draft' }))).toBe('widget #12 · checks skipped · draft')
    expect(row(prItem({ ci: 'passed', review: 'unresolved', unresolved: 2 }))).toBe(
      'widget #12 · checks passed · 2 unresolved comments',
    )
    expect(row(prItem({ ci: 'passed', review: 'blocked' }))).toBe('widget #12 · checks passed · blocked from merging')
    expect(row(prItem({ ci: 'passed', review: 'behind' }))).toBe('widget #12 · checks passed · branch behind base')
    expect(row(prItem({ ci: 'passed', review: 'conflict' })), 'conflict leads while CI is not failing').toBe(
      'widget #12 · merge conflict · checks passed',
    )
    expect(row(prItem({ ci: 'passed', review: 'changes' }))).toBe('widget #12 · changes requested · checks passed')
    expect(row(prItem({ ci: 'failing', failing: ['lint'], review: 'changes' })), 'failing CI still leads').toBe(
      'widget #12 · checks failing: lint · changes requested',
    )
    expect(row(prItem({ ci: 'running' }, { errorStreak: 3 }))).toBe(
      "widget #12 · checks running 3/7 · waiting for review · can't reach GitHub",
    )
  })

  test('release phase rows: <repo> #<pr> · <step>/<total> · <phrase>', () => {
    expect(row(releaseItem({}))).toBe('widget #12 · 1/4 · waiting for workflow to start')
    expect(row(releaseItem({ floatingTag: 'v1', total: 3 }))).toBe('widget #12 · 1/3 · dispatch release.yml to move v1')
    expect(row(releaseItem({ runStatus: 'queued' }))).toBe('widget #12 · 1/4 · workflow queued')
    expect(row(releaseItem({ runStatus: 'in_progress', runStartedAt: NOW - 80_000 }))).toBe(
      'widget #12 · 1/4 · workflow running 1m 20s',
    )
    expect(row(releaseItem({ stage: 'tag', step: 2 }))).toBe('widget #12 · 2/4 · workflow done, waiting for tag')
    expect(row(releaseItem({ stage: 'release', step: 3, tag: 'v1.2.3' }))).toBe(
      'widget #12 · 3/4 · tagged v1.2.3, waiting for GitHub release',
    )
    const artifacts = { image: { pkg: 'acme/widget' }, chart: { pkg: 'acme/charts/widget' } }
    expect(row(releaseItem({ stage: 'artifacts', step: 4, tag: 'v1.2.3', artifacts }))).toBe(
      'widget #12 · 4/4 · v1.2.3 released, waiting for image + chart',
    )
    expect(
      row(releaseItem({ stage: 'artifacts', step: 4, tag: 'v1.2.3', artifacts: { ...artifacts, chart: { pkg: 'c', version: '1.2.3' } } })),
    ).toBe('widget #12 · 4/4 · v1.2.3 released, waiting for image')
    expect(row(releaseItem({ stage: 'artifacts', step: 4, tag: 'v1.2.3', artifacts: { chart: { pkg: 'c' } } }))).toBe(
      'widget #12 · 4/4 · v1.2.3 released, waiting for chart',
    )
    expect(row(releaseItem({ stage: 'tag', step: 2 }, { pr: undefined, id: 'rel:acme/widget@1' })), 'no PR: no #').toBe(
      'widget · 2/4 · workflow done, waiting for tag',
    )
  })

  test('every "nothing to do" outcome has its own words', () => {
    const phrases = OUTCOMES.map(o => row(doneItem(o)))
    expect(phrases).toEqual([
      'widget #12 · v1.2.3 published',
      'widget #12 · v1.2.3 released',
      'widget #12 · v1.2.3 released, no image',
      'widget #12 · tagged v1.2.3, no GitHub release',
      'widget #12 · merged · no release expected (no semver label)',
      'widget #12 · merged into dev · no release expected',
      'widget #12 · merged · no release workflow',
      'widget #12 · workflow ran, cut no version',
      'widget #12 · release workflow never started',
      'widget #12 · release workflow failed',
      'widget #12 · gave up after 20 min (tag)',
      'widget #12 · closed without merging',
      'widget #12 · PR not found',
    ])
  })

  test('toasts, one per event kind, verbatim', () => {
    const t = (ev: MonitorEvent) => toastFor(ev, CONFIG)
    const base = item()
    expect(t({ kind: 'checks-failed', item: base, names: ['lint', 'test'] })).toEqual({
      text: 'widget #12: checks failed — lint, test',
      timeoutMs: 8000,
    })
    expect(t({ kind: 'checks-passed', item: base })).toEqual({ text: 'widget #12: all checks passed', timeoutMs: 4000 })
    expect(t({ kind: 'changes-requested', item: base })).toEqual({ text: 'widget #12: changes requested', timeoutMs: 6000 })
    expect(t({ kind: 'merged', item: releaseItem({}) })).toEqual({
      text: 'widget #12: merged — watching the release',
      timeoutMs: 4000,
    })
    expect(t({ kind: 'floating-tag-stale', item: doneItem({ kind: 'released', tag: 'v1.2.3' }), tag: 'v1' })).toEqual({
      text: 'widget #12: floating tag v1 not moved — dispatch release.yml',
      timeoutMs: 10000,
    })
    expect(t({ kind: 'deploy-offer', item: offerItem() })).toEqual({
      text: 'widget v1.2.3 is out — [ bump ] on the band drafts the homelab-k8s bump',
      timeoutMs: 10000,
    })
    const outcomes = OUTCOMES.map(o => t({ kind: 'outcome', item: doneItem(o) }))
    expect(outcomes).toEqual([
      { text: 'widget #12: v1.2.3 published (GitHub release + image + chart)', timeoutMs: 8000 },
      { text: 'widget #12: v1.2.3 released (GitHub release)', timeoutMs: 8000 },
      { text: 'widget #12: v1.2.3 released; no image after 20 min', timeoutMs: 8000 },
      { text: 'widget #12: tagged v1.2.3, but no GitHub release appeared', timeoutMs: 6000 },
      { text: 'widget #12: merged — no release expected (no semver label)', timeoutMs: 6000 },
      { text: 'widget #12: merged into dev — no release expected', timeoutMs: 6000 },
      { text: 'widget #12: merged — repo has no release workflow (release.yml)', timeoutMs: 6000 },
      { text: 'widget #12: release.yml ran but cut no new version', timeoutMs: 6000 },
      { text: 'widget #12: release.yml never started — stopped watching', timeoutMs: 6000 },
      { text: 'widget #12: release.yml failed (failure)', timeoutMs: 10000 },
      { text: 'widget #12: gave up after 20 min waiting for the tag', timeoutMs: 10000 },
      { text: 'widget #12: closed without merging', timeoutMs: 6000 },
      undefined,
    ])
  })

  test('a merge that ends at once toasts once, with the outcome', () => {
    const done = doneItem({ kind: 'no-semver-label' })
    const toasts = toastsFor([{ kind: 'merged', item: done }, { kind: 'outcome', item: done }], CONFIG)
    expect(toasts.map(x => x.text)).toEqual(['widget #12: merged — no release expected (no semver label)'])
  })

  test('the deploy prompt is a ready-to-send request that says not to merge', () => {
    expect(deployPrompt(offerItem())).toBe(
      "Bump apps/widget/helmfile.yaml in acme/homelab-k8s to widget v1.2.3 (image ghcr.io/acme/widget:v1.2.3, chart 1.2.3) and open a PR for review. Don't merge it.",
    )
    const imageOnly = offerItem()
    imageOnly.deploy = { ...imageOnly.deploy!, chartVersion: undefined }
    expect(deployPrompt(imageOnly)).toBe(
      "Bump apps/widget/helmfile.yaml in acme/homelab-k8s to widget v1.2.3 (image ghcr.io/acme/widget:v1.2.3) and open a PR for review. Don't merge it.",
    )
    expect(deployPrompt(item()), 'no offer, no prompt').toBe('')
  })
})

describe('status line (design §3.5)', () => {
  test('cleared when nothing is live; one live item shows its row', () => {
    expect(statusLine(snap([]))).toBeUndefined()
    expect(statusLine(snap([doneItem({ kind: 'closed' })])), 'done items are not live').toBeUndefined()
    expect(statusLine(snap([releaseItem({ stage: 'tag', step: 2 })]))).toBe('widget #12 · 2/4 · workflow done, waiting for tag')
    expect(statusLine(snap([offerItem()])), 'an open deploy offer is live').toBe('widget v1.2.3 → homelab-k8s')
  })

  test('several live items: a summary, singular PR, the one failing repo named', () => {
    expect(statusLine(canonical())).toBe('2 PRs · 1 failing · 1 in review · 1 releasing · 1 to deploy')
    const two = snap([prItem({ ci: 'passed', review: 'approved' }), releaseItem({}, { pr: 13, id: 'pr:acme/widget#13' })])
    expect(statusLine(two)).toBe('1 PR · 1 ready · 1 releasing')
    const named = snap([prItem({ ci: 'failing', failing: ['lint'] }), releaseItem({}, { pr: 13, id: 'pr:acme/widget#13' })])
    expect(statusLine(named), 'the one failing repo is named when it fits').toBe('1 PR · 1 failing (widget) · 1 releasing')
    const rel = snap([releaseItem({}), releaseItem({}, { pr: 13, id: 'pr:acme/widget#13' })])
    expect(statusLine(rel), 'no PR term when no PR is in the PR phase').toBe('2 releasing')
  })

  test('the status never carries a prefix: the engine adds " ⚠ gh-monitor: " itself', () => {
    for (const s of [statusLine(canonical()), statusLine(snap([prItem({})]))]) {
      expect(s?.startsWith('gh-monitor'), s).toBe(false)
      expect(s?.includes('⚠'), s).toBe(false)
    }
  })
})

describe('widths', () => {
  test(`status <= ${STATUS_BUDGET}, rows <= columns, toasts <= ${TOAST_BUDGET}, with long names and versions`, () => {
    expect([STATUS_MAX, TOAST_MAX]).toEqual([STATUS_BUDGET, TOAST_BUDGET])
    for (const it of everyRow(LONG_REPO, LONG_VERSION)) {
      const s = statusLine(snap([it]))
      if (s !== undefined) {
        expect(width(s), s).toBeLessThanOrEqual(STATUS_BUDGET)
        expect(s.includes('acme/'), `owner shown: ${s}`).toBe(false)
        expect(s.includes('…'), `long name elided: ${s}`).toBe(true)
      }
      for (const c of COLUMNS) {
        for (const r of bandRows(snap([it]), c, 10)) {
          expect(bandRowCells(r), `${c} cols: ${r.text}`).toBeLessThanOrEqual(c)
          expect(r.text.includes('acme/'), r.text).toBe(false)
        }
        for (const b of paneBlocks(snap([it]), c)) {
          for (const l of b.lines) expect(width(l.text), `pane ${c}: ${l.text}`).toBeLessThanOrEqual(c)
          expect(width(b.header)).toBeLessThanOrEqual(c)
        }
      }
      const events: MonitorEvent[] = [
        { kind: 'checks-failed', item: it, names: LONG_CHECKS },
        { kind: 'checks-passed', item: it },
        { kind: 'changes-requested', item: it },
        { kind: 'merged', item: it },
        { kind: 'outcome', item: it },
        { kind: 'floating-tag-stale', item: it, tag: LONG_VERSION },
        { kind: 'deploy-offer', item: it },
      ]
      for (const t of toastsFor(events, CONFIG)) {
        expect(width(t.text), t.text).toBeLessThanOrEqual(TOAST_BUDGET)
        expect(t.text.includes('acme/'), t.text).toBe(false)
      }
    }
  })

  test('a long name is elided with … and the step count survives', () => {
    const it = releaseItem({ stage: 'release', step: 3, tag: LONG_VERSION }, { repo: LONG_REPO, id: 'x' })
    const s = statusLine(snap([it])) as string
    expect(s).toMatch(/^a-very-long-r…? ?#12 · 3\/4 · /)
    expect(s.includes('…')).toBe(true)
  })

  test('many items: the summary fits and keeps failing; the band stays within maxRows', () => {
    for (const n of [1, 2, 7, 30]) {
      const s = snap(many(n))
      const line = statusLine(s) as string
      expect(width(line), line).toBeLessThanOrEqual(STATUS_BUDGET)
      if (n > 1) expect(line.includes('failing'), line).toBe(true)
      for (const c of COLUMNS) {
        for (const maxRows of [3, 6, 40]) {
          const rows = bandRows(s, c, maxRows)
          expect(rows.length, `${n} items, ${maxRows} rows`).toBeLessThanOrEqual(maxRows)
          for (const r of rows) expect(bandRowCells(r), `${c}: ${r.text}`).toBeLessThanOrEqual(c)
          if (n > maxRows) expect(rows.at(-1)?.key).toBe(OVERFLOW_KEY)
        }
      }
    }
    expect(bandRows(snap(many(30)), 80, 6).at(-1)?.text).toBe('+25 more · /gh-monitor for all')
  })

  test('elide never exceeds its bound', () => {
    for (const n of [0, 1, 2, 5, 66]) expect(width(elide(LONG_REPO, n))).toBeLessThanOrEqual(n)
    expect(elide('short', 10)).toBe('short')
  })
})

describe('band rows (design §3.4)', () => {
  test('hidden when nothing is active; failures first, then offers, releasing, running, review, done', () => {
    expect(bandRows(snap([]), 80, 10)).toEqual([])
    const old = doneItem({ kind: 'closed' }, { doneAt: NOW - 11 * 60_000 })
    expect(bandRows(snap([old]), 80, 10), 'done over 10 min ago: gone').toEqual([])
    const rows = bandRows(canonical(), 80, 10)
    expect(rows.map(r => `${r.marker} ${r.text}`)).toEqual([
      '✗ earmark #178 · checks failing: lint, test · waiting for review',
      '↑ scrim v0.47.9 → homelab-k8s',
      '● widget #12 · 2/4 · workflow done, waiting for tag',
      '◐ deck #32 · checks passed · waiting for review',
    ])
    expect(rows[1]?.buttons.map(b => [b.label, b.hotkey])).toEqual([
      ['bump', '2'],
      ['x', undefined],
    ])
  })

  test('markers are dropped under 40 columns; buttons when the text would get under 24', () => {
    expect(bandRows(canonical(), 36, 10).every(r => r.marker === '')).toBe(true)
    expect(bandRows(canonical(), 40, 10).every(r => r.marker !== '')).toBe(true)
    const narrow = bandRows(snap([offerItem()]), 36, 10)
    expect(narrow[0]?.buttons, '36 - 15 < 24').toEqual([])
    expect(bandRows(snap([offerItem()]), 41, 10)[0]?.buttons.length).toBe(2)
  })
})

describe('capture', () => {
  test('the canonical scenario at 80 columns (README "What it looks like")', () => {
    const s = canonical()
    expect(statusLine(s)).toBe('2 PRs · 1 failing · 1 in review · 1 releasing · 1 to deploy')
    expect(bandRows(s, 80, 10).map(r => `${r.marker} ${r.text}`)).toEqual([
      '✗ earmark #178 · checks failing: lint, test · waiting for review',
      '↑ scrim v0.47.9 → homelab-k8s',
      '● widget #12 · 2/4 · workflow done, waiting for tag',
      '◐ deck #32 · checks passed · waiting for review',
    ])
  })
})
