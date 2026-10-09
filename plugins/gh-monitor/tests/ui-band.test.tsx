/**
 * The band and the pane drawn through the plugin's own ui.render hooks on
 * the terminal and the desktop. The test stands in for the engine's state
 * (`state.get` answered from a fixture Snapshot), the prompt box and the pane
 * opener; no engine work is needed to draw.
 */
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../hooks/engine/model'
import { toView } from '../hooks/ui/state'
import { deployPrompt } from '../hooks/ui/text'
import { canonical, doneItem, NOW, offerItem, prItem, releaseItem, snap, many, check } from './fixtures/items'

const PLUGIN = 'gh-monitor'
const SURFACES = ['terminal', 'desktop'] as const
const SCROLL = { offset: 0, bodyRows: 10 }

function bandProps(over: { bodyColumns?: number; maxRows?: number; hasSurvey?: boolean } = {}) {
  return {
    hasSurvey: over.hasSurvey ?? false,
    isWorking: false,
    maxRows: over.maxRows ?? 10,
    bodyColumns: over.bodyColumns ?? 80,
    scroll: SCROLL,
    view: {},
  }
}

function paneProps(bodyColumns = 80) {
  return { title: 'GitHub', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: SCROLL, view: {} }
}

/** Serves `view` as the plugin's state, records prompt fills and state writes. */
function world(on: On, view: Snapshot, draft = '') {
  const fills: { text: string; mode: string }[] = []
  const stateWrites: unknown[] = []
  mock.store(on)
  mock.clock(on)
  on('state.get', () => ({ value: { value: toView(view), version: 1 } }))
  on('state.set', ($, e) => {
    stateWrites.push(e)
    return { value: { isSet: true, version: 2 } }
  })
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('process.run', () => ({ deny: 'no gh in render tests' }))
  // The engine's own drawing, under the plugin: an empty band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-default" />
  })
  return { fills, stateWrites }
}

describe('band', () => {
  test('hidden when nothing is active, and while a survey holds the band', async ($, on) => {
    world(on, snap([doneItem({ kind: 'closed' }, { doneAt: NOW - 11 * 60_000 })]))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps() })
      expect(await ui.find({ text: /closed/ }), surface).toBeUndefined()
      await ui.unmount()
      const survey = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'AbovePrompt',
        props: bandProps({ hasSurvey: true }),
      })
      expect(await survey.find({ text: /widget/ })).toBeUndefined()
      await survey.unmount()
    }
  })

  test('one row per active item, failures first, the offer with [ bump ] and [ x ]', async ($, on) => {
    const w = world(on, canonical())
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps() })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim().length > 2)
      expect(texts, surface).toEqual([
        'earmark #178 · checks failing: lint, test · waiting for review',
        'scrim v0.47.9 → homelab-k8s',
        'widget #12 · 2/4 · workflow done, waiting for tag',
        'deck #32 · checks passed · waiting for review',
      ])
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => [b.props.label, b.props.hotkey])).toEqual([
        ['bump', '2'],
        ['x', undefined],
      ])
      await ui.unmount()
    }
    expect(w.stateWrites, 'render hooks never write state').toEqual([])
    expect(w.fills, 'nothing is drafted until the person presses bump').toEqual([])
  })

  test('[ bump ] drafts the deploy request into an empty box (replace), never sends', async ($, on) => {
    const w = world(on, snap([offerItem()]))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
    await ui.press({ key: 'bump:pr:acme/widget#12' })
    expect(w.fills).toEqual([{ text: deployPrompt(offerItem()), mode: 'replace' }])
    await ui.unmount()
  })

  test('[ bump ] appends to a draft on its own line', async ($, on) => {
    const w = world(on, snap([offerItem()]), 'half-typed thought')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: bandProps() })
    await ui.press({ key: 'bump:pr:acme/widget#12' })
    expect(w.fills).toEqual([{ text: `\n${deployPrompt(offerItem())}`, mode: 'append' }])
    await ui.unmount()
  })

  test('markers and buttons drop at 36 columns; every row fits', async ($, on) => {
    world(on, canonical())
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: bandProps({ bodyColumns: 36 }),
    })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => /^[✗●◐✓·↑] $/.test(t))).toBe(false)
    for (const t of texts) expect([...t].length, t).toBeLessThanOrEqual(36)
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  })

  test('over maxRows: failures kept, a "+N more" row last', async ($, on) => {
    world(on, snap(many(30)))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: bandProps({ maxRows: 5 }),
    })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim().length > 2)
    expect(texts).toHaveLength(5)
    expect(texts[0]).toMatch(/failing/)
    expect(texts.at(-1)).toBe('+26 more · /gh-monitor for all')
    await ui.unmount()
  })
})

describe('pane', () => {
  test('full detail: check names and timings, run link, tag, digest, chart, stop button', async ($, on) => {
    const failing = prItem(
      {
        ci: 'failing',
        failing: ['lint'],
        checks: [
          check('lint', 'fail', { url: 'https://github.com/acme/widget/actions/runs/1', startedAt: NOW - 70_000, completedAt: NOW - 10_000 }),
          check('test', 'pending', { startedAt: NOW - 30_000 }),
        ],
      },
      { title: 'Add the thing' },
    )
    const releasing = releaseItem(
      {
        stage: 'artifacts',
        step: 4,
        tag: 'v1.2.3',
        runUrl: 'https://github.com/acme/widget/actions/runs/9',
        runStartedAt: NOW - 120_000,
        artifacts: { image: { pkg: 'acme/widget', digest: 'sha256:abc' }, chart: { pkg: 'acme/charts/widget' } },
      },
      { pr: 13, id: 'pr:acme/widget#13' },
    )
    world(on, snap([failing, releasing, offerItem({ pr: 14, id: 'pr:acme/widget#14' })]))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: paneProps(), requestId: 'gh-monitor' })
      expect(await ui.find({ type: 'Text', text: /acme\/widget #12 — Add the thing/ })).toBeDefined()
      expect(await ui.find({ text: '  ✗ lint (1m)' })).toBeDefined()
      expect(await ui.find({ text: '  ● test (running 30s)' })).toBeDefined()
      const run = await ui.find({ type: 'Link', text: /workflow: release\.yml/ })
      expect(run?.props.href).toBe('https://github.com/acme/widget/actions/runs/9')
      expect(await ui.find({ text: 'tag: v1.2.3' })).toBeDefined()
      expect(await ui.find({ text: 'image: acme/widget sha256:abc' })).toBeDefined()
      expect(await ui.find({ text: 'chart: acme/charts/widget (waiting)' })).toBeDefined()
      const labels = (await ui.findAll({ type: 'Button' })).map(b => b.key)
      expect(labels, 'failing, then the offer, then releasing').toEqual([
        'stop:pr:acme/widget#12',
        'bump:pr:acme/widget#14',
        'x:pr:acme/widget#14',
        'stop:pr:acme/widget#13',
      ])
      await ui.unmount()
    }
  })

  test('says so when nothing is watched; lines fit narrow panes', async ($, on) => {
    world(on, snap([]))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: paneProps(30), requestId: 'gh-monitor' })
    expect(await ui.find({ text: /Nothing watched/ })).toBeDefined()
    await ui.unmount()
  })
})
