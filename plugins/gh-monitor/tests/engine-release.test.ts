import { describe, expect, test } from 'claude-code/testing'

import { isReleaseRun, pickReleaseWorkflow } from '../hooks/engine/github'
import {
  CI_WF,
  cutRelease,
  cutTag,
  engineRig,
  finishRun,
  github,
  iso,
  KEY,
  MERGE_SHA,
  mergePr,
  OLD_SHA,
  PR_ID,
  pushChart,
  pushImage,
  RELEASE_SHA,
  releaseRun,
} from './fixtures/github'
import type { GitHub, Rig } from './fixtures/github'

/** A watched PR that merges now; returns the rig after the merge is seen. */
async function merged(gh: GitHub, options: Record<string, unknown> = {}, labels = ['semver:patch']): Promise<Rig> {
  const r = engineRig(gh, options)
  await r.engine.watchPr('12')
  mergePr(gh, KEY, { at: r.now(), labels })
  r.engine.onPrompt('merged', 'composer')
  await r.settle()
  return r
}
const rel = (r: Rig) => r.item(PR_ID)?.release
const outcome = (r: Rig) => r.item(PR_ID)?.outcome

describe('merged: what happens next', () => {
  test('no semver label: "no release expected" at once, no run polling', async () => {
    const gh = github()
    const r = await merged(gh, {}, [])
    expect(outcome(r)).toEqual({ kind: 'no-semver-label' })
    expect(r.kinds()).toEqual(['merged'])
    expect(r.item(PR_ID)?.phase).toBe('done')
    await r.tick()
    expect(r.runs.some(x => x.includes('actions/runs'))).toBe(false)
  })

  test('a SEMVER:MINOR label in any case counts', async () => {
    const r = await merged(github(), {}, ['SEMVER:Minor'])
    expect(r.item(PR_ID)?.phase).toBe('release')
  })

  test('merged into a non-default branch: no release expected', async () => {
    const gh = github()
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    mergePr(gh, KEY, { base: 'dev' })
    r.engine.onPrompt('merged', 'composer')
    await r.settle()
    expect(outcome(r)).toEqual({ kind: 'not-default-branch', base: 'dev' })
  })

  test('repo with no release workflow', async () => {
    const r = await merged(github({ workflows: [{ id: CI_WF, name: 'CI', path: '.github/workflows/ci.yml' }] }))
    expect(outcome(r)).toEqual({ kind: 'no-release-workflow', workflow: 'release.yml' })
  })

  test('unreadable workflow list: stays merged-pending, retried next tick', async () => {
    const gh = github({ broken: ['actions/workflows?'] })
    const r = await merged(gh)
    expect(r.item(PR_ID)?.phase).toBe('pr')
    expect(r.events).toEqual([])
    gh.broken = []
    await r.tick()
    expect(r.item(PR_ID)?.phase).toBe('release')
    expect(r.kinds()).toEqual(['merged'])
  })
})

describe('the release walk', () => {
  test('workflow -> tag -> GitHub release -> image + chart -> published, 4 steps', async () => {
    const gh = github({ packages: { image: 'users', chart: 'orgs' } })
    const r = await merged(gh)
    expect(rel(r)).toMatchObject({ stage: 'run', step: 1, total: 4, workflow: 'release.yml' })
    expect(rel(r)?.artifacts).toEqual({ image: { pkg: 'acme/widget' }, chart: { pkg: 'acme/charts/widget' } })

    releaseRun(gh, { status: 'in_progress', run_started_at: iso(5_000) })
    await r.tick()
    expect(rel(r)).toMatchObject({ stage: 'run', runStatus: 'in_progress', runStartedAt: 5_000, runUrl: 'https://github.com/acme/widget/actions/runs/100' })

    finishRun(gh)
    cutRelease(gh)
    await r.tick()
    expect(rel(r)).toMatchObject({ stage: 'artifacts', step: 4, tag: 'v1.2.3' })

    pushImage(gh)
    await r.tick()
    expect(rel(r)?.artifacts?.image?.digest).toBe(`sha256:${'d'.repeat(64)}`)
    expect(outcome(r)).toBeUndefined()

    pushChart(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3', chart: '1.2.3' })
    expect(r.kinds()).toEqual(['merged', 'outcome'])
  })

  test('image only: published with the image; no artifacts: released after 3 steps', async () => {
    const gh = github({ packages: { image: 'orgs' } })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    pushImage(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3' })

    const gh2 = github()
    const r2 = await merged(gh2)
    expect(rel(r2)?.total).toBe(3)
    releaseRun(gh2, { status: 'completed', conclusion: 'success' })
    cutRelease(gh2)
    await r2.tick()
    expect(outcome(r2)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('GHCR before the GitHub release, and the other way round', async () => {
    const gh = github({ packages: { image: 'users' } })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutTag(gh)
    pushImage(gh)
    await r.tick()
    expect(rel(r)?.stage).toBe('release')
    gh.releases.push('v1.2.3')
    await r.tick()
    expect(outcome(r)?.kind).toBe('published')

    const gh2 = github({ packages: { image: 'users' } })
    const r2 = await merged(gh2)
    releaseRun(gh2, { status: 'completed', conclusion: 'success' })
    cutRelease(gh2)
    await r2.tick()
    expect(rel(r2)?.stage).toBe('artifacts')
    pushImage(gh2)
    await r2.tick()
    expect(outcome(r2)?.kind).toBe('published')
  })

  test('display name vs file name: the run is matched by workflow id, not a newer CI run on the same commit', async () => {
    const gh = github({ workflows: [{ id: 7, name: 'Release', path: '.github/workflows/release.yml' }, { id: CI_WF, name: 'CI', path: '.github/workflows/ci.yml' }] })
    const r = await merged(gh)
    releaseRun(gh, { id: 100, workflow_id: 7, status: 'in_progress', created_at: iso(1_000) })
    releaseRun(gh, { id: 101, workflow_id: CI_WF, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'failure', created_at: iso(2_000) })
    await r.tick()
    expect(rel(r)?.runStatus).toBe('in_progress')
    expect(outcome(r)).toBeUndefined()
  })

  test('release workflow detection: configured file, a release-ish file, a release-ish name', () => {
    const wf = (id: number, name: string, file: string) => ({ id, name, path: `.github/workflows/${file}` })
    expect(pickReleaseWorkflow([wf(1, 'CI', 'ci.yml'), wf(2, 'Ship it', 'publish.yml')], 'publish.yml')?.id).toBe(2)
    expect(pickReleaseWorkflow([wf(1, 'CI', 'ci.yml'), wf(3, 'Cut', 'auto-release.yaml')], 'release.yml')?.id).toBe(3)
    expect(pickReleaseWorkflow([wf(1, 'CI', 'ci.yml'), wf(4, 'Release Please', 'rp.yml')], 'release.yml')?.id).toBe(4)
    expect(pickReleaseWorkflow([wf(1, 'CI', 'ci.yml')], 'release.yml')).toBeUndefined()
    const w = wf(9, 'Release', 'release.yml')
    expect(isReleaseRun({ id: 1, status: 'queued', conclusion: null, name: 'Release' }, w)).toBe(true)
    expect(isReleaseRun({ id: 1, status: 'queued', conclusion: null, path: '.github/workflows/release.yml@refs/heads/main' }, w)).toBe(false)
    expect(isReleaseRun({ id: 1, status: 'queued', conclusion: null, workflowId: 9, name: 'Other' }, w)).toBe(true)
  })

  test('run succeeded, no tag within 90 s: "cut no version" (the deck#32 case)', async () => {
    const gh = github()
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    await r.tick()
    expect(rel(r)?.stage).toBe('tag')
    await r.tick(60_000)
    expect(outcome(r)).toBeUndefined()
    await r.tick(30_000)
    expect(outcome(r)).toEqual({ kind: 'no-version-cut', workflow: 'release.yml' })
  })

  test('run skipped or neutral: cut no version; failure: failed with the run link', async () => {
    for (const conclusion of ['skipped', 'neutral']) {
      const gh = github()
      const r = await merged(gh)
      releaseRun(gh, { status: 'completed', conclusion })
      await r.tick()
      expect(outcome(r), conclusion).toEqual({ kind: 'no-version-cut', workflow: 'release.yml' })
    }
    const gh = github()
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'failure' })
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'failed', workflow: 'release.yml', conclusion: 'failure', url: 'https://github.com/acme/widget/actions/runs/100' })
  })

  test('a tag with no GitHub release for 2 min: tagged-only; a draft does not count', async () => {
    const gh = github({ drafts: ['v1.2.3'] })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutTag(gh)
    await r.tick()
    expect(rel(r)?.stage).toBe('release')
    await r.tick(60_000)
    expect(outcome(r)).toBeUndefined()
    await r.tick(60_000)
    expect(outcome(r)).toEqual({ kind: 'tagged-only', tag: 'v1.2.3' })
  })

  test('chart never appears: released, missing chart, at the deadline', async () => {
    const gh = github({ packages: { image: 'users', chart: 'users' } })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    pushImage(gh)
    await r.tick()
    for (let t = 1; t < 40 && !outcome(r); t++) await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3', missing: ['chart'] })
    expect(r.now()).toBeGreaterThanOrEqual(20 * 60_000)
  })

  test('gate on, no run ever: gives up at the 20 min deadline', async () => {
    const gh = github()
    const r = await merged(gh)
    for (let t = 0; t < 39; t++) await r.tick()
    expect(outcome(r)).toBeUndefined()
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'timeout', stage: 'run', minutes: 20 })
  })

  test('gate off: every default-branch merge waits, but only 3 min for a run', async () => {
    const gh = github()
    const r = await merged(gh, { semverLabelGate: 'false' }, [])
    expect(r.item(PR_ID)?.phase).toBe('release')
    await r.tick(120_000)
    expect(outcome(r)).toBeUndefined()
    await r.tick(60_000)
    expect(outcome(r)).toEqual({ kind: 'no-run', workflow: 'release.yml' })
  })

  test('the person says "merged" after the tag was cut: the release is still found', async () => {
    const gh = github()
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    mergePr(gh, KEY, { at: 0 })
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    r.at(4 * 60_000)
    r.engine.onPrompt('merged', 'composer')
    await r.settle()
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('an unrelated new tag (another branch) is not taken', async () => {
    const gh = github({ ancestry: { ['f'.repeat(40)]: 'diverged' } })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh, 'v9.9.9', 'f'.repeat(40))
    await r.tick()
    expect(rel(r)?.stage).toBe('tag')
  })
})

describe('floating tags', () => {
  const FLOAT = { floatingTagRepos: 'acme/widget:v1' }

  test('no label needed; waits for a dispatched run; nags when v1 was not moved', async () => {
    const gh = github({ floating: { v1: OLD_SHA } })
    const r = await merged(gh, FLOAT, [])
    expect(rel(r)).toMatchObject({ stage: 'run', floatingTag: 'v1' })
    for (let t = 0; t < 8; t++) await r.tick()
    expect(outcome(r), 'no 3 min give-up for a floating repo').toBeUndefined()
    releaseRun(gh, { id: 200, head_sha: 'e'.repeat(40), event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(r.now()) })
    cutRelease(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
    expect(r.kinds()).toEqual(['merged', 'outcome', 'floating-tag-stale'])
    expect(r.events.at(-1)).toMatchObject({ tag: 'v1' })
  })

  test('moved to the release commit: no nag; a failed run never nags', async () => {
    const gh = github({ floating: { v1: RELEASE_SHA } })
    const r = await merged(gh, FLOAT)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    await r.tick()
    expect(r.kinds()).toEqual(['merged', 'outcome'])

    const gh2 = github({ floating: { v1: OLD_SHA } })
    const r2 = await merged(gh2, FLOAT)
    releaseRun(gh2, { status: 'completed', conclusion: 'failure' })
    await r2.tick()
    expect(r2.kinds()).toEqual(['merged', 'outcome'])
  })
})

describe('dispatch and repo watches', () => {
  test('gh workflow run: the first dispatched run after it is followed to the release', async () => {
    const gh = github()
    const r = engineRig(gh)
    r.at(100_000)
    r.engine.afterTool({ tool: 'Bash', command: 'gh workflow run release.yml -R acme/widget', result: { result: { stdout: '' } } })
    await r.settle()
    releaseRun(gh, { id: 50, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: iso(10_000) }) // an old one
    releaseRun(gh, { id: 51, head_sha: MERGE_SHA, event: 'workflow_dispatch', status: 'in_progress', created_at: iso(101_000) })
    await r.tick()
    const item = r.engine.snapshot().items[0]
    expect(item?.release?.runUrl).toBe('https://github.com/acme/widget/actions/runs/51')
    finishRun(gh, 'success', 51)
    cutRelease(gh)
    await r.tick()
    expect(r.engine.snapshot().items[0]?.outcome).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('/watch-release <repo> with no run yet waits for the next one', async () => {
    const gh = github()
    const r = engineRig(gh)
    r.at(50 * 60_000)
    expect(await r.engine.watchRelease('acme/widget')).toBe('watching widget releases')
    releaseRun(gh, { id: 60, status: 'in_progress', created_at: iso(51 * 60_000) })
    await r.tick()
    expect(r.engine.snapshot().items[0]?.release?.runStatus).toBe('in_progress')
  })
})

describe('deploy hand-off', () => {
  const DEPLOY = { deployRepos: 'acme/widget=acme/deploy:apps/widget/helmfile.yaml' }

  test('published + configured app: one offer; filled / dismissed; never on released-missing', async () => {
    const gh = github({ packages: { image: 'users', chart: 'users' } })
    const r = await merged(gh, DEPLOY)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    pushImage(gh)
    pushChart(gh)
    await r.tick()
    expect(r.kinds()).toEqual(['merged', 'outcome', 'deploy-offer'])
    expect(r.item(PR_ID)?.deploy).toEqual({
      target: { appRepo: 'acme/widget', deployRepo: 'acme/deploy', path: 'apps/widget/helmfile.yaml' },
      version: 'v1.2.3',
      image: 'ghcr.io/acme/widget:v1.2.3',
      chartVersion: '1.2.3',
      state: 'offered',
    })
    r.engine.deployFilled(PR_ID)
    expect(r.item(PR_ID)?.deploy?.state).toBe('filled')
    r.engine.deployDismissed(PR_ID)
    expect(r.item(PR_ID)?.deploy?.state).toBe('dismissed')

    const gh2 = github({ packages: { image: 'users', chart: 'users' } })
    const r2 = await merged(gh2, DEPLOY)
    releaseRun(gh2, { status: 'completed', conclusion: 'success' })
    cutRelease(gh2)
    pushImage(gh2)
    for (let t = 0; t < 40 && !outcome(r2); t++) await r2.tick()
    expect(outcome(r2)?.kind).toBe('released')
    expect(r2.item(PR_ID)?.deploy).toBeUndefined()
  })

  test('no offer for an app that is not configured; an unclaimed offer expires after 60 min', async () => {
    const gh = github({ packages: { image: 'users' } })
    const r = await merged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    pushImage(gh)
    await r.tick()
    expect(r.item(PR_ID)?.deploy).toBeUndefined()

    const gh2 = github({ packages: { image: 'users' } })
    const r2 = await merged(gh2, DEPLOY)
    releaseRun(gh2, { status: 'completed', conclusion: 'success' })
    cutRelease(gh2)
    pushImage(gh2)
    await r2.tick()
    expect(r2.item(PR_ID)?.deploy?.state).toBe('offered')
    expect(r2.timers(), 'an open offer keeps the timer').toBe(1)
    const doneAt = r2.item(PR_ID)?.doneAt as number
    await r2.tick(doneAt + 60 * 60_000 - r2.now()) // exactly the TTL: expired, not yet forgotten
    expect(r2.item(PR_ID)?.deploy?.state).toBe('dismissed')
  })
})
