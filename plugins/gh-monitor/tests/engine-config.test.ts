import { describe, expect, test } from 'claude-code/testing'

import { boolOf, configOf, listOf, parseDeployRepos, parseFloatingTagRepos } from '../hooks/engine/config'

describe('config', () => {
  test('defaults', () => {
    const c = configOf(undefined)
    expect(c.releaseWorkflow).toBe('release.yml')
    expect(c.registry).toBe('ghcr.io')
    expect(c.timeoutMs).toBe(20 * 60_000)
    expect(c.pollMs).toBe(30_000)
    expect(c.floatingTags).toEqual([])
    expect(c.deployTargets).toEqual([])
    expect(c.sweepRepos).toEqual([])
    expect(c.nudge).toBe(false)
    expect(c.semverLabelGate).toBe(true)
  })

  test('configure saves strings: numbers, bools and lists all parse from them', () => {
    const c = configOf({
      releaseWorkflow: '.github/workflows/auto-release.yml',
      registry: 'ghcr.io/',
      timeoutMin: '45',
      pollSec: '15',
      nudge: 'TRUE',
      semverLabelGate: 'off',
      floatingTagRepos: 'acme/action:v1, acme/other:v2',
      deployRepos: 'a/b=c/d:x.yaml, e/f=g/h:apps/f/helmfile.yaml',
      sweepRepos: '["acme/widget","acme/gadget","acme/widget"]',
    })
    expect(c.releaseWorkflow).toBe('auto-release.yml')
    expect(c.registry).toBe('ghcr.io')
    expect(c.timeoutMs).toBe(45 * 60_000)
    expect(c.pollMs).toBe(15_000)
    expect(c.nudge).toBe(true)
    expect(c.semverLabelGate).toBe(false)
    expect(c.floatingTags).toEqual([
      { repo: 'acme/action', tag: 'v1' },
      { repo: 'acme/other', tag: 'v2' },
    ])
    expect(c.deployTargets).toEqual([
      { appRepo: 'a/b', deployRepo: 'c/d', path: 'x.yaml' },
      { appRepo: 'e/f', deployRepo: 'g/h', path: 'apps/f/helmfile.yaml' },
    ])
    expect(c.sweepRepos, 'deduped').toEqual(['acme/widget', 'acme/gadget'])
  })

  test('real types work too', () => {
    const c = configOf({ timeoutMin: 5, pollSec: 60, nudge: true, semverLabelGate: false, deployRepos: ['a/b=c/d:p.yaml'] })
    expect(c.timeoutMs).toBe(5 * 60_000)
    expect(c.pollMs).toBe(60_000)
    expect(c.nudge).toBe(true)
    expect(c.semverLabelGate).toBe(false)
    expect(c.deployTargets).toHaveLength(1)
  })

  test('junk falls back to defaults; poll clamps to 10 s', () => {
    const c = configOf({ timeoutMin: '0', pollSec: '2', nudge: 'maybe', semverLabelGate: 7, releaseWorkflow: '   ', registry: 3 })
    expect(c.timeoutMs).toBe(20 * 60_000)
    expect(c.pollMs, 'clamped up').toBe(10_000)
    expect(c.nudge).toBe(false)
    expect(c.semverLabelGate).toBe(true)
    expect(c.releaseWorkflow).toBe('release.yml')
    expect(c.registry).toBe('ghcr.io')
    expect(configOf({ timeoutMin: 'abc', pollSec: '' }).pollMs).toBe(30_000)
  })

  test('malformed list entries are dropped', () => {
    expect(parseDeployRepos('nope, a/b=c/d, a/b=c/d:, a/b=:x, a/b=c/d:../x, a/b=c/d:ok.yaml')).toEqual([
      { appRepo: 'a/b', deployRepo: 'c/d', path: 'ok.yaml' },
    ])
    expect(parseFloatingTagRepos(['acme/x', 'acme/y:', ':v1', 'acme/z:v1'])).toEqual([{ repo: 'acme/z', tag: 'v1' }])
    expect(parseFloatingTagRepos('[not json')).toEqual([])
  })

  test('parsers', () => {
    expect(listOf('a, b  c,,')).toEqual(['a', 'b', 'c'])
    expect(listOf(['a', 3, 'b'])).toEqual(['a', 'b'])
    expect(listOf(undefined)).toEqual([])
    for (const v of ['true', '1', 'yes', 'On', true, 1]) expect(boolOf(v, false), String(v)).toBe(true)
    for (const v of ['false', '0', 'no', 'OFF', false, 0]) expect(boolOf(v, true), String(v)).toBe(false)
  })
})
