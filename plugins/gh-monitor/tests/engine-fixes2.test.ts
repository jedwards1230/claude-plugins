/** Second QA round (done-QA2 "Still open"): repros first, then the fix. */
import { describe, expect, test } from 'claude-code/testing'

import { bashPrRequests, typedMerged } from '../hooks/engine/arm'
import { createGitHub } from '../hooks/engine/github'
import { isWorthReading } from '../hooks/engine/shell'
import {
  answer,
  bashResult,
  cutRelease,
  engineRig,
  finishRun,
  github,
  iso,
  KEY,
  mergePr,
  openPr,
  PR_ID,
  pushChart,
  pushImage,
  releaseRun,
  running,
} from './fixtures/github'
import type { FixturePr, GitHub, Rig } from './fixtures/github'

const URL12 = 'https://github.com/acme/widget/pull/12'
const outcome = (r: Rig) => r.item(PR_ID)?.outcome

async function created(gh: GitHub, options: Record<string, unknown> = {}): Promise<Rig> {
  const r = engineRig(gh, options)
  r.at(1_000_000)
  r.engine.afterTool({ tool: 'Bash', command: 'gh pr create --title t', result: bashResult(`${URL12}\n`) })
  await r.settle()
  return r
}

describe('re-watching a finished PR', () => {
  async function closedThenReopenedAndMerged(): Promise<{ gh: GitHub; r: Rig }> {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = await created(gh)
    ;(gh.prs[KEY] as FixturePr).state = 'CLOSED'
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'closed' })
    ;(gh.prs[KEY] as FixturePr).state = 'OPEN'
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    return { gh, r }
  }

  test('Q7: closed, then reopened and merged: an implicit touch (gh pr ready) picks the merge up', async () => {
    const { r } = await closedThenReopenedAndMerged()
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr ready 12 -R acme/widget', result: bashResult('') })
    await r.settle()
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('Q7: typed "merged #12" and /watch-pr after a close both start over', async () => {
    const a = await closedThenReopenedAndMerged()
    a.r.engine.onPrompt('merged #12', 'composer')
    await a.r.settle()
    await a.r.tick()
    expect(outcome(a.r)).toEqual({ kind: 'released', tag: 'v1.2.3' })

    const b = await closedThenReopenedAndMerged()
    expect(await b.r.engine.watchPr('12')).toBe('watching widget #12')
    await b.r.tick()
    expect(outcome(b.r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('Q8: a release that gave up is watched again by /watch-pr and /watch-release --pr', async () => {
    for (const how of ['pr', 'release'] as const) {
      const gh = github()
      const r = await created(gh)
      mergePr(gh, KEY, { at: r.now() })
      await r.tick()
      for (let t = 0; t < 41 && !outcome(r); t++) await r.tick()
      expect(outcome(r)?.kind, how).toBe('timeout')
      releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
      cutRelease(gh)
      const reply = how === 'pr' ? await r.engine.watchPr('12') : await r.engine.watchRelease('acme/widget --pr 12')
      expect(reply).toBe('watching widget #12')
      await r.tick()
      expect(outcome(r), how).toEqual({ kind: 'released', tag: 'v1.2.3' })
    }
  })

  test('a closed PR that stays closed: an implicit touch drops it quietly', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const r = await created(gh)
    ;(gh.prs[KEY] as FixturePr).state = 'CLOSED'
    await r.tick()
    const before = r.kinds().length
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr view 12 -R acme/widget', result: bashResult('') })
    await r.settle()
    await r.tick()
    expect(r.kinds().slice(before)).toEqual([])
  })
})

describe('GHCR names', () => {
  test('a mixed-case repo: lower-cased for the Packages API and the registry -> published', async () => {
    const gh = github({ packagesApi: 'forbidden', packages: { image: 'users', chart: 'users' }, prs: { 'Acme/Widget#12': openPr() } })
    const r = engineRig(gh)
    r.at(1_000_000)
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr create', result: bashResult('https://github.com/Acme/Widget/pull/12\n') })
    await r.settle()
    mergePr(gh, 'Acme/Widget#12', { at: r.now() })
    await r.tick()
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    pushImage(gh, 'v1.2.3', { bare: true })
    pushChart(gh)
    await r.tick()
    expect(r.engine.snapshot().items[0]?.outcome).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:1.2.3', chart: '1.2.3' })
    expect(r.runs.some(x => /Acme|Widget/.test(x) && (x.includes('/packages/') || x.includes('ghcr.io')))).toBe(false)
  })

  test('the registry answering NAME_INVALID means absent, not "ask again"', async () => {
    const gh = github({ packagesApi: 'forbidden', packages: { image: 'users' } })
    const client = createGitHub(async argv => answer(gh, argv))
    expect(await client.probePackage('ghcr.io', 'Acme', 'Widget')).toBe('absent')
    expect(await client.probePackage('ghcr.io', 'acme', 'widget')).toEqual({ owner: 'acme', name: 'widget', via: 'registry' })
  })

  test('packages still unknown at the deadline: released with them missing, not plain released', async () => {
    const gh = github({ packages: { image: 'users', chart: 'users' }, broken: ['/packages/container/', 'ghcr.io/token'] })
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    await r.tick()
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    for (let t = 0; t < 45 && !outcome(r); t++) await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3', missing: ['image', 'chart'] })
  })
})

describe('caller-run fallback', () => {
  const WFS = [
    { id: 1, name: 'Release', path: '.github/workflows/release.yml' },
    { id: 4, name: 'Release Drafter', path: '.github/workflows/release-drafter.yml' },
  ]

  test('Q9: a release-drafter run seen first does not lock out release.yml', async () => {
    const gh = github({ workflows: WFS })
    releaseRun(gh, { id: 5, head_sha: 'e'.repeat(40), status: 'completed', conclusion: 'success', at: -86_400_000 }) // release.yml has run before
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { id: 90, workflow_id: 4, name: 'Release Drafter', path: '.github/workflows/release-drafter.yml', status: 'completed', conclusion: 'success', at: r.now() })
    await r.tick(60_000)
    releaseRun(gh, { id: 100, status: 'in_progress', at: r.now() })
    await r.tick(60_000)
    await r.tick(60_000) // the drafter "succeeded" 2 min ago: following it would end as no-version-cut by now
    expect(r.item(PR_ID)?.release).toMatchObject({ workflow: 'release.yml', runStatus: 'in_progress' })
    finishRun(gh)
    cutRelease(gh)
    await r.tick(60_000)
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('N18: the configured workflow wins over a newer release-like run on the same commit', async () => {
    const gh = github({ workflows: WFS })
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { id: 100, status: 'in_progress', at: r.now() })
    releaseRun(gh, { id: 101, workflow_id: 4, name: 'Release Drafter', path: '.github/workflows/release-drafter.yml', status: 'completed', conclusion: 'success', at: r.now() + 1000 })
    await r.tick()
    expect(r.item(PR_ID)?.release).toMatchObject({ runStatus: 'in_progress', workflow: 'release.yml' })
  })

  test('a configured workflow that has run before but not yet now: the fallback waits for the run grace', async () => {
    const gh = github({ workflows: WFS })
    releaseRun(gh, { id: 5, head_sha: 'e'.repeat(40), status: 'completed', conclusion: 'success', at: -86_400_000 })
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { id: 90, workflow_id: 4, name: 'Release Drafter', path: '.github/workflows/release-drafter.yml', status: 'in_progress', at: r.now() })
    await r.tick()
    expect(r.item(PR_ID)?.release?.runStatus).toBeUndefined()
    await r.tick(3 * 60_000)
    expect(r.item(PR_ID)?.release?.workflow).toBe('release-drafter.yml')
  })

  test('N12 / N13: on the PR head only a pull_request run created after the merge counts', async () => {
    const AUTO = [{ id: 1, name: 'Release', path: '.github/workflows/release.yml' }, { id: 3, name: 'Auto Release', path: '.github/workflows/auto-release.yml' }]
    const head = '1'.repeat(40)
    const gh = github({ workflows: AUTO })
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { id: 70, head_sha: head, workflow_id: 3, path: '.github/workflows/auto-release.yml', event: 'push', status: 'completed', conclusion: 'failure', at: r.now() })
    releaseRun(gh, { id: 71, head_sha: head, workflow_id: 3, path: '.github/workflows/auto-release.yml', event: 'pull_request', status: 'completed', conclusion: 'failure', created_at: iso(r.now() - 10 * 60_000) })
    await r.tick()
    expect(outcome(r), 'neither the push run nor the old pull_request run').toBeUndefined()
    expect(r.item(PR_ID)?.release?.runStatus).toBeUndefined()
  })
})

describe('nits', () => {
  test('gh -R=o/r before the subcommand', () => {
    expect(bashPrRequests('gh -R=o/r pr view 20', bashResult(''))).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 20 }])
  })
  test('"merged 3 PRs" names no PR; "merged 178." and "merged #4 too" do', () => {
    expect(typedMerged('merged 3 PRs')).toEqual({ matched: true })
    expect(typedMerged('merged 178.')).toEqual({ matched: true, pr: 178 })
    expect(typedMerged('merged #4 too')).toEqual({ matched: true, pr: 4 })
  })
  test('a later command\'s "No such file" never hides a merge earlier in the chain', () => {
    expect(isWorthReading({ isError: true, result: 'Exit code 1\n✓ Merged\nrm: missing: No such file or directory' })).toBe(true)
    expect(isWorthReading({ isError: true, result: 'zsh: command not found: gh' })).toBe(false)
  })
  test('M9: a new tag on a commit behind the merge is not the release', async () => {
    const gh = github({ ancestry: { ['9'.repeat(40)]: 'behind' } })
    const r = await created(gh)
    mergePr(gh, KEY, { at: r.now() })
    await r.tick()
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    gh.tags = [{ name: 'v9.0.0', sha: '9'.repeat(40) }, ...gh.tags]
    await r.tick()
    expect(r.item(PR_ID)?.release?.stage).toBe('tag')
    expect(finishRun).toBeDefined()
  })
})
