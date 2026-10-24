/**
 * "What it looks like": every user-visible string, produced by the real
 * render code (../hooks/ui/text) from fixtures, each with its width, plus a
 * labelled terminal mock. Printed between CAPTURE markers so
 * tests/capture.sh can lift it into the PR body / README; the assertions keep
 * every captured string inside its budget, so a capture that runs is a
 * capture that fits.
 */
import { expect, test } from 'claude-code/testing'

import type { Item, MonitorEvent, Outcome } from '../hooks/engine/model'
import type { BandRow } from '../hooks/ui/text'
import { bandRowCells, bandRows, deployPrompt, statusLine, toastsFor, width } from '../hooks/ui/text'
import {
  canonical,
  doneItem,
  item,
  LONG_REPO,
  LONG_VERSION,
  many,
  NOW,
  offerItem,
  prItem,
  releaseItem,
  snap,
} from './fixtures/items'

/** The test runtime has a console; the hooks lib (no DOM) does not declare one. */
declare const console: { log: (text: string) => void }

const STATUS_BUDGET = 66
const TOAST_BUDGET = 100
/** What Claude Code itself puts before a plugin's status text. */
const PREFIX = ' ⚠ gh-monitor: '
const CONFIG = { timeoutMs: 20 * 60_000, releaseWorkflow: 'release.yml' }

/** A band row as the terminal draws it: marker, text, `[ bump ]` / `[ x ]`. */
function drawRow(r: BandRow): string {
  return `${r.marker ? `${r.marker} ` : ''}${r.text}${r.buttons.map(b => ` [ ${b.label} ]`).join('')}`
}

const sized = (s: string) => `${String(width(s)).padStart(3)} │ ${s}`

const OUTCOMES: Outcome[] = [
  { kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3', chart: '1.2.3' },
  { kind: 'released', tag: 'v1.2.3' },
  { kind: 'released', tag: 'v1.2.3', missing: ['chart'] },
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

function walk(): Item[] {
  const artifacts = { image: { pkg: 'acme/widget' }, chart: { pkg: 'acme/charts/widget' } }
  return [
    prItem({ ci: 'starting', review: 'unknown' }),
    prItem({ ci: 'running' }),
    prItem({ ci: 'failing', passed: 5, failed: 2, pending: 0, failing: ['lint', 'test'] }),
    prItem({ ci: 'passed', passed: 7, pending: 0, review: 'requested' }),
    prItem({ ci: 'passed', passed: 7, pending: 0, review: 'changes' }),
    prItem({ ci: 'passed', passed: 7, pending: 0, review: 'approved-ready' }),
    prItem({ ci: 'none', review: 'requested' }),
    releaseItem({}),
    releaseItem({ runStatus: 'in_progress', runStartedAt: NOW - 80_000, artifacts }),
    releaseItem({ stage: 'tag', step: 2, artifacts }),
    releaseItem({ stage: 'release', step: 3, tag: 'v1.2.3', artifacts }),
    releaseItem({ stage: 'artifacts', step: 4, tag: 'v1.2.3', artifacts }),
    releaseItem({ floatingTag: 'v1', total: 3 }),
    ...OUTCOMES.map(o => doneItem(o)),
    offerItem(),
  ]
}

test('capture: every string the UI shows, with widths', () => {
  const out: string[] = []
  const section = (title: string) => out.push('', `## ${title}`, '')

  section(`Status line (text only; Claude Code prefixes "${PREFIX}") — budget ${STATUS_BUDGET}`)
  const statuses = [
    statusLine(canonical()),
    ...walk().map(i => statusLine(snap([i]))),
    statusLine(snap([releaseItem({ stage: 'release', step: 3, tag: LONG_VERSION }, { repo: LONG_REPO })])),
    statusLine(snap(many(30))),
  ].filter((s): s is string => s !== undefined)
  for (const s of statuses) {
    expect(width(s), s).toBeLessThanOrEqual(STATUS_BUDGET)
    out.push(sized(s))
  }
  out.push('', '(A lone finished item is not live: its outcome shows as a toast and on the band, and the status line is cleared.)')

  for (const columns of [120, 80, 40]) {
    section(`Band at ${columns} columns (canonical scenario)`)
    for (const r of bandRows(canonical(), columns, 10)) {
      expect(bandRowCells(r), drawRow(r)).toBeLessThanOrEqual(columns)
      out.push(sized(drawRow(r)))
    }
  }
  section('Band at 60 columns, 30 items, maxRows 6 (long repo names)')
  for (const r of bandRows(snap(many(30)), 60, 6)) {
    expect(bandRowCells(r)).toBeLessThanOrEqual(60)
    out.push(sized(drawRow(r)))
  }
  section('Band rows for every stage and outcome at 80 columns')
  for (const i of walk()) {
    for (const r of bandRows(snap([i]), 80, 10)) out.push(sized(drawRow(r)))
  }

  section(`Toasts — budget ${TOAST_BUDGET}`)
  const events: MonitorEvent[] = [
    { kind: 'checks-failed', item: item(), names: ['lint', 'test'] },
    { kind: 'checks-passed', item: item() },
    { kind: 'changes-requested', item: item() },
    { kind: 'merged', item: releaseItem({}) },
    ...OUTCOMES.map((o): MonitorEvent => ({ kind: 'outcome', item: doneItem(o) })),
    { kind: 'floating-tag-stale', item: doneItem({ kind: 'released', tag: 'v1.2.3' }), tag: 'v1' },
    { kind: 'deploy-offer', item: offerItem() },
    { kind: 'checks-failed', item: item({ repo: LONG_REPO }), names: ['a'.repeat(40), 'b'.repeat(40), 'c'] },
  ]
  for (const t of toastsFor(events, CONFIG)) {
    expect(width(t.text), t.text).toBeLessThanOrEqual(TOAST_BUDGET)
    out.push(`${sized(t.text)}   (${t.timeoutMs / 1000}s)`)
  }

  section('Deploy prompt ([ bump ] drafts this in the prompt box; never sent)')
  out.push(deployPrompt(offerItem()))

  section('Terminal mock, 80 columns (canonical scenario)')
  const rule = (label: string) => `── ${label} ${'─'.repeat(Math.max(0, 76 - width(label)))}`
  const mock = [
    rule('transcript'),
    '⏺ Merged acme/widget#12 on GitHub; the release workflow has finished.',
    '',
    rule('band (above the prompt)'),
    ...bandRows(canonical(), 80, 10).map(drawRow),
    rule('prompt'),
    '> ',
    rule('status line (prefix drawn by Claude Code)'),
    `${PREFIX}${statusLine(canonical()) ?? ''}`,
  ]
  for (const line of mock) expect(width(line), line).toBeLessThanOrEqual(82)
  out.push(...mock)

  console.log(['=====CAPTURE BEGIN', ...out, '=====CAPTURE END'].join('\n'))
})
