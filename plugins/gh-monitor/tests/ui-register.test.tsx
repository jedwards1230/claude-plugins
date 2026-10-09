/**
 * The whole plugin through `$`: hooks registered by register.tsx over the
 * engine and the scripted GitHub (./fixtures/github). The test's hooks stand
 * in for Claude Code beneath the plugin: `process.run` answers from the
 * fixture, `ui.status` / `ui.toast` / `state.*` / `prompt.*` / `command.register`
 * are recorded, and the clock is mocked.
 */
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  answer,
  cutRelease,
  finishRun,
  github,
  KEY,
  mergePr,
  openPr,
  passed,
  pushImage,
  releaseRun,
  REPO,
  running,
} from './fixtures/github'
import type { GitHub } from './fixtures/github'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work/widget' } as const
const POLL = 30_000
const PR_URL = `https://github.com/${REPO}/pull/12`
const CREATE = `gh pr create --title "Add the thing" --body x -R ${REPO}`
const CREATE_RESULT = { result: { stdout: `${PR_URL}\n`, stderr: '', interrupted: false } }
const COMPOSER = { kind: 'composer' } as const
const SCROLL = { offset: 0, bodyRows: 10 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: SCROLL, view: {} }

/** Claude Code beneath the plugin, over a scripted GitHub. */
function world(on: On, gh: GitHub, toolAnswer: unknown = CREATE_RESULT) {
  const runs: string[] = []
  const timeouts: (number | undefined)[] = []
  const statuses: (string | undefined)[] = []
  const toasts: { text: string; timeoutMs?: number }[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  const commands: string[] = []
  const fills: { text: string; mode: string }[] = []
  const state = new Map<string, unknown>()
  let stateSets = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('process.run', async ($, e) => {
    runs.push(e.argv.join(' '))
    timeouts.push(e.init?.timeoutMs)
    if (gh.broken.includes('REJECT')) return { deny: 'could not start' }
    return { value: answer(gh, e.argv) as never }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push({ text: e.text, timeoutMs: e.timeoutMs })
    return { value: undefined }
  })
  on('state.get', ($, e) => ({ value: { value: state.get(`${e.plugin}.${e.key}`) as never, version: stateSets } }))
  on('state.set', ($, e) => {
    stateSets++
    state.set(`${e.plugin}.${e.key}`, e.value)
    return { value: { isSet: true, version: stateSets } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', ($, e) => {
    prompts.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text } as never
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-default" />
  })
  on('tool.call', () => (typeof toolAnswer === 'function' ? toolAnswer() : toolAnswer) as never)
  mock.store(on)
  const clock = mock.clock(on)
  return { runs, timeouts, statuses, toasts, prompts, commands, fills, clock, stateSets: () => stateSets }
}

async function create($: Engine, w: ReturnType<typeof world>) {
  await $.session.start(SESSION)
  const r = await $.tool.call({ tool: 'Bash', command: CREATE })
  await w.clock.settle()
  return r
}

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: COMPOSER } as never) as Promise<{ text: string; context?: readonly string[] }>

describe('register: token neutrality', () => {
  test('tool.call results come back untouched, Bash and Monitor', async ($, on) => {
    const w = world(on, github())
    await $.session.start(SESSION)
    const bash = await $.tool.call({ tool: 'Bash', command: CREATE })
    expect(bash).toEqual(CREATE_RESULT)
    const monitor = await $.tool.call({
      tool: 'Monitor',
      description: 'ci',
      timeout_ms: 60_000,
      command: `python3 ci-watch.py ${REPO}#12`,
    } as never)
    expect(monitor).toEqual(CREATE_RESULT)
    await w.clock.settle()
  })

  test('nudge off: prompts carry no added context, even after a merge', async ($, on) => {
    const gh = github()
    const w = world(on, gh)
    await create($, w)
    mergePr(gh, KEY, { labels: [] })
    await submit($, 'merged')
    await w.clock.advance(POLL)
    await submit($, 'thanks')
    expect(w.prompts.every(p => p.context === undefined), JSON.stringify(w.prompts)).toBe(true)
  })

  test('nudge on: exactly one context block after a merge', { options: { nudge: true } }, async ($, on) => {
    const gh = github()
    const w = world(on, gh)
    await create($, w)
    mergePr(gh, KEY, { labels: [] })
    await w.clock.advance(POLL)
    await submit($, 'what next?')
    await submit($, 'and now?')
    const withContext = w.prompts.filter(p => p.context && p.context.length > 0)
    expect(withContext, JSON.stringify(w.prompts)).toHaveLength(1)
  })
})

describe('register: one PR from create to published', () => {
  test('status and toasts in order; the status clears once published', async ($, on) => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('test')] }) }, packages: { image: 'users' } })
    const w = world(on, gh)
    await create($, w)
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1)).toMatch(/^widget #12 · checks running 0\/1 · /)

    gh.prs[KEY] = openPr({ checks: [passed('test')], reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })
    await w.clock.advance(POLL)
    expect(w.toasts.map(t => t.text)).toContain('widget #12: all checks passed')

    mergePr(gh, KEY, { at: w.clock.now() })
    await submit($, 'merged')
    await w.clock.settle()
    await w.clock.advance(POLL)
    expect(w.toasts.map(t => t.text)).toContain('widget #12: merged — watching the release')
    expect(w.statuses.at(-1)).toMatch(/^widget #12 · 1\/4 · /)

    releaseRun(gh, { at: w.clock.now() })
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1)).toMatch(/^widget #12 · 1\/4 · workflow running/)

    finishRun(gh)
    cutRelease(gh)
    await w.clock.advance(POLL)
    expect(w.statuses.at(-1)).toBe('widget #12 · 4/4 · v1.2.3 released, waiting for image')

    pushImage(gh)
    await w.clock.advance(POLL)
    expect(w.toasts.at(-1)).toEqual({ text: 'widget #12: v1.2.3 published (GitHub release + image)', timeoutMs: 8000 })
    expect(w.statuses.at(-1)).toBeUndefined()
    for (const s of w.statuses) if (s !== undefined) expect([...s].length, s).toBeLessThanOrEqual(66)
    expect(new Set(w.timeouts), 'every gh call is capped at 15 s').toEqual(new Set([15_000]))
  })

  test('a gh call that cannot start is swallowed: no toast, the tool result untouched', async ($, on) => {
    const gh = github()
    const w = world(on, gh)
    gh.broken.push('REJECT')
    const r = await create($, w)
    for (let i = 0; i < 3; i++) await w.clock.advance(POLL)
    expect(r).toEqual(CREATE_RESULT)
    expect(w.toasts).toEqual([])
    expect(w.runs.length, 'it did try').toBeGreaterThan(0)
  })

  test('a merge with no semver label says so at once: one toast, no release polling', async ($, on) => {
    const gh = github()
    const w = world(on, gh)
    await create($, w)
    mergePr(gh, KEY, { labels: [] })
    await w.clock.advance(POLL)
    expect(w.toasts.map(t => t.text)).toEqual(['widget #12: merged — no release expected (no semver label)'])
    expect(w.runs.some(r => r.includes('/actions/runs')), 'no run polling').toBe(false)
    expect(w.statuses.at(-1)).toBeUndefined()
  })
})

describe('register: commands, band, pane', () => {
  test('the three commands register and answer one short line', async ($, on) => {
    const w = world(on, github())
    await $.session.start(SESSION)
    await w.clock.settle()
    expect([...new Set(w.commands)].sort()).toEqual(['gh-monitor', 'watch-pr', 'watch-release'])
    const origin = COMPOSER
    for (const [command, args] of [
      ['watch-pr', `${REPO}#12`],
      ['watch-pr', ''],
      ['watch-release', REPO],
      ['gh-monitor', 'stop nothing-here'],
      ['gh-monitor', ''],
    ] as const) {
      const r = (await $.command.run({ command, args, origin, presentation: {} } as never)) as { text?: string }
      expect(typeof r.text, `${command} ${args}`).toBe('string')
      expect(r.text?.includes('\n'), r.text).toBe(false)
      expect([...(r.text ?? '')].length, r.text).toBeLessThanOrEqual(80)
    }
  })

  test('drawing the band or the pane never writes state', async ($, on) => {
    const w = world(on, github({ prs: { [KEY]: openPr({ checks: [running('test')] }) } }))
    await create($, w)
    await w.clock.advance(POLL)
    const before = w.stateSets()
    expect(before, 'the subscriber wrote the view').toBeGreaterThan(0)
    const band = await $.ui.mount({ plugin: 'gh-monitor', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /^widget #12 · checks running/ })).toBeDefined()
    await band.redraw()
    const pane = await $.ui.mount({
      plugin: 'gh-monitor',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'gh-monitor',
      props: { title: 'GitHub', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: /acme\/widget #12/ })).toBeDefined()
    expect(w.stateSets(), 'render hooks only read').toBe(before)
    await band.unmount()
    await pane.unmount()
  })

  test('the deploy offer: a toast, a [ bump ] that drafts (never sends), then the button goes', {
    options: { deployRepos: 'acme/widget=acme/homelab-k8s:apps/widget/helmfile.yaml' },
  }, async ($, on) => {
    const gh = github({ packages: { image: 'users' } })
    const w = world(on, gh)
    await create($, w)
    mergePr(gh, KEY, { at: w.clock.now() })
    await w.clock.advance(POLL)
    releaseRun(gh, { at: w.clock.now() })
    finishRun(gh)
    cutRelease(gh)
    pushImage(gh)
    for (let i = 0; i < 3; i++) await w.clock.advance(POLL)
    expect(w.toasts.map(t => t.text)).toContain('widget v1.2.3 is out — [ bump ] on the band drafts the homelab-k8s bump')
    expect(w.statuses.at(-1), 'an open offer is live').toBe('widget v1.2.3 → homelab-k8s')

    const band = await $.ui.mount({ plugin: 'gh-monitor', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const bump = (await band.findAll({ type: 'Button' })).find(b => b.props.label === 'bump')
    expect(bump?.key).toBe('bump:pr:acme/widget#12')
    await band.press({ key: bump?.key as string })
    await w.clock.settle()
    expect(w.fills).toEqual([
      {
        text: 'Bump apps/widget/helmfile.yaml in acme/homelab-k8s to widget v1.2.3 (image ghcr.io/acme/widget:v1.2.3) and open a PR for review. Don\'t merge it.',
        mode: 'replace',
      },
    ])
    expect(w.prompts, 'drafted, never submitted').toEqual([])
    await band.redraw()
    expect(await band.findAll({ type: 'Button' }), 'the offer is filled').toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
    await band.unmount()
  })

  test('the pane\'s stop button stops polling that PR', async ($, on) => {
    const w = world(on, github({ prs: { [KEY]: openPr({ checks: [running('test')] }) } }))
    await create($, w)
    await w.clock.advance(POLL)
    await $.command.run({ command: 'gh-monitor', args: '', origin: COMPOSER, presentation: {} } as never)
    const pane = await $.ui.mount({
      plugin: 'gh-monitor',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'gh-monitor',
      props: { title: 'GitHub', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
    })
    await pane.press({ key: 'stop:pr:acme/widget#12' })
    await w.clock.settle()
    const polled = w.runs.length
    for (let i = 0; i < 5; i++) await w.clock.advance(POLL)
    expect(w.runs.length, 'no gh calls after stop').toBe(polled)
    expect(w.statuses.at(-1)).toBeUndefined()
    await pane.unmount()
  })
})
