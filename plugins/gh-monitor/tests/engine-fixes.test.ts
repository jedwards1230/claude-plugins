/**
 * Repros from the independent QA round (Q1-Q6, bugs 1-8) and the mutations
 * that survived it, each pinned by a test that fails on the old behaviour.
 */
import { describe, expect, test } from 'claude-code/testing'

import { bashPrRequests, parsePrCommands, typedMerged } from '../hooks/engine/arm'
import { checksOfContexts, classify, hasSemverLabel } from '../hooks/engine/classify'
import { KEY_PREFIX } from '../hooks/engine/store'
import {
  bashResult,
  cutRelease,
  engineRig,
  finishRun,
  github,
  HEAD_SHA,
  iso,
  KEY,
  mergePr,
  openPr,
  passed,
  PR_ID,
  pushChart,
  pushImage,
  releaseRun,
  RELEASE_SHA,
  running,
} from './fixtures/github'
import type { FixturePr, GitHub, Rig } from './fixtures/github'

const DEPLOY = { deployRepos: 'acme/widget=acme/deploy:apps/widget/helmfile.yaml' }
const URL12 = 'https://github.com/acme/widget/pull/12'

/** A PR created this session, merged with a semver label at `r.now()`. */
async function createdAndMerged(gh: GitHub, options: Record<string, unknown> = {}): Promise<Rig> {
  const r = engineRig(gh, options)
  r.at(1_000_000)
  r.engine.afterTool({ tool: 'Bash', command: 'gh pr create --title t', result: bashResult(`${URL12}\n`) })
  await r.settle()
  mergePr(gh, KEY, { at: r.now() })
  await r.tick()
  return r
}
const outcome = (r: Rig) => r.item(PR_ID)?.outcome

describe('bug 1: GHCR packages read without read:packages', () => {
  test('API 403: public image (v-less tag only) and chart read from the registry anonymously -> 4/4 published + offer', async () => {
    const gh = github({ packagesApi: 'forbidden', packages: { image: 'users', chart: 'users' } })
    const r = await createdAndMerged(gh, DEPLOY)
    expect(r.item(PR_ID)?.release?.total).toBe(4)
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    pushImage(gh, 'v1.2.3', { bare: true })
    pushChart(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:1.2.3', chart: '1.2.3' })
    expect(r.item(PR_ID)?.release?.artifacts?.image?.digest).toBe(`sha256:${'d'.repeat(64)}`)
    expect(r.kinds()).toContain('deploy-offer')
    expect(r.runs.some(x => x.startsWith('curl -sS --max-time 15 '))).toBe(true)
  })

  test('API 403 and the registry denies anonymous pulls: no packages, 3 steps, released', async () => {
    const gh = github({ packagesApi: 'forbidden' })
    const r = await createdAndMerged(gh)
    expect(r.item(PR_ID)?.release?.total).toBe(3)
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('Q6: a probe that fails at merge time is asked again later, never dropped', async () => {
    const gh = github({ packages: { image: 'users', chart: 'users' }, broken: ['/packages/container/', 'ghcr.io/token'] })
    const r = await createdAndMerged(gh, DEPLOY)
    expect(r.item(PR_ID)?.release?.total, 'still might publish artifacts').toBe(4)
    gh.broken = []
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    pushImage(gh)
    pushChart(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3', chart: '1.2.3' })
  })

  test('M11: through the API, an image tagged only 1.2.3 still counts', async () => {
    const gh = github({ packages: { image: 'users' } })
    const r = await createdAndMerged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    pushImage(gh, 'v1.2.3', { bare: true })
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:1.2.3' })
  })
})

describe('bug 2: errored Bash results still arm', () => {
  test('Q5: gh pr checks exits 8, gh pr merge && failing git pull', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }), 'acme/widget#13': openPr({ checks: [running('ci')], branch: 'b13' }) } })
    const r = engineRig(gh)
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr checks 12 -R acme/widget', result: { isError: true, result: 'Exit code 8\nci pending', text: 'Exit code 8' } })
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr merge 13 -R acme/widget --squash && git pull', result: { isError: true, result: 'Exit code 1\nfatal: no upstream', text: '' } })
    await r.settle()
    expect(r.engine.snapshot().items.map(i => i.id).sort()).toEqual(['pr:acme/widget#12', 'pr:acme/widget#13'])
  })
})

describe('bug 3: a finished PR is never re-armed', () => {
  async function published(): Promise<{ gh: GitHub; r: Rig }> {
    const gh = github({ packages: { image: 'users', chart: 'users' } })
    const r = await createdAndMerged(gh, DEPLOY)
    gh.mergedList = [{ number: 12, url: URL12, mergedAt: iso(r.now()) }]
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    pushImage(gh)
    pushChart(gh)
    await r.tick()
    expect(r.kinds()).toEqual(['merged', 'outcome', 'deploy-offer'])
    r.engine.deployDismissed(PR_ID)
    return { gh, r }
  }

  test('Q1: gh pr view after the release: no new events, the dismissed offer stays dismissed', async () => {
    const { r } = await published()
    const before = r.kinds().length
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr view 12 -R acme/widget --json state', result: bashResult('{"state":"MERGED"}') })
    await r.settle()
    await r.tick()
    await r.tick()
    expect(r.kinds().slice(before)).toEqual([])
    expect(r.item(PR_ID)?.deploy?.state).toBe('dismissed')
  })

  test('Q2: typing "merged" with nothing open skips the PR already followed to the end', async () => {
    const { r } = await published()
    const before = r.kinds().length
    r.engine.onPrompt('merged', 'composer')
    await r.settle()
    await r.tick()
    expect(r.kinds().slice(before)).toEqual([])
    r.engine.onPrompt('merged #12', 'composer')
    await r.settle()
    expect(r.kinds().slice(before)).toEqual([])
  })
})

describe('bug 4: a merge seen late still gets a real look', () => {
  test('Q3: merged and released while the laptop slept 25 min: released, not "gave up"', async () => {
    const gh = github()
    const r = engineRig(gh)
    r.at(1_000_000)
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr create --title t', result: bashResult(`${URL12}\n`) })
    await r.settle()
    mergePr(gh, KEY, { at: r.now() })
    releaseRun(gh, { at: r.now(), status: 'completed', conclusion: 'success' })
    cutRelease(gh)
    await r.tick(25 * 60_000)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('a release already watched when the laptop slept past its deadline: one look first, then released', async () => {
    const gh = github()
    const r = await createdAndMerged(gh)
    expect(r.item(PR_ID)?.phase).toBe('release')
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    await r.tick(30 * 60_000)
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
  })

  test('the deadline runs from when the merge was first seen', async () => {
    const gh = github()
    mergePr(gh, KEY, { at: 0 })
    const r = engineRig(gh)
    r.at(5 * 60_000)
    r.engine.onPrompt('merged #12', 'composer')
    await r.settle()
    expect(r.item(PR_ID)?.release?.deadline).toBe(25 * 60_000)
  })
})

describe('bug 5: calling workflows', () => {
  const WFS = [
    { id: 1, name: 'Release', path: '.github/workflows/release.yml' },
    { id: 3, name: 'Auto Release', path: '.github/workflows/auto-release.yml' },
    { id: 2, name: 'CI', path: '.github/workflows/ci.yml' },
  ]

  test('release.yml is workflow_call-only: the auto-release.yml run on the merge commit is the release run', async () => {
    const gh = github({ workflows: WFS })
    const r = await createdAndMerged(gh)
    releaseRun(gh, { workflow_id: 2, id: 99, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', at: r.now() })
    releaseRun(gh, { workflow_id: 3, name: 'Auto Release', path: '.github/workflows/auto-release.yml', status: 'in_progress', at: r.now() })
    await r.tick()
    expect(r.item(PR_ID)?.release?.runStatus).toBe('in_progress')
    expect(r.item(PR_ID)?.release?.workflow, 'named after the run followed').toBe('auto-release.yml')
    finishRun(gh)
    cutRelease(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })
    expect(r.runs.some(x => x.includes(`head_sha=${'a'.repeat(40)}&per_page=100`))).toBe(true)
  })

  test('a release on pull_request: closed runs on the PR head commit', async () => {
    const gh = github({ workflows: WFS })
    const r = await createdAndMerged(gh)
    releaseRun(gh, { id: 98, head_sha: HEAD_SHA, workflow_id: 2, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', at: r.now() })
    await r.tick()
    expect(r.item(PR_ID)?.release?.runStatus, 'a CI run on the head is not the release').toBeUndefined()
    releaseRun(gh, { head_sha: HEAD_SHA, workflow_id: 3, path: '.github/workflows/auto-release.yml', event: 'pull_request', status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    await r.tick()
    expect(outcome(r)).toEqual({ kind: 'released', tag: 'v1.2.3' })

    const gh2 = github({ workflows: WFS })
    const r2 = await createdAndMerged(gh2)
    releaseRun(gh2, { head_sha: HEAD_SHA, workflow_id: 3, path: '.github/workflows/auto-release.yml', event: 'pull_request', status: 'completed', conclusion: 'failure', at: r2.now() })
    await r2.tick()
    expect(r2.item(PR_ID)?.outcome).toMatchObject({ kind: 'failed', workflow: 'auto-release.yml', conclusion: 'failure' })
  })
})

describe('bug 6: one bad item never freezes the others', () => {
  test('Q4: a stored release with no workflow is dropped at boot', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const store = new Map<string, unknown>([[`${KEY_PREFIX}session-1`, { savedAt: 0, items: [
      { id: 'rel:acme/x@1', repo: 'acme/x', phase: 'release', armedAt: 0, lastTransitionAt: 0, errorStreak: 0, confirmed: true, touchedAt: 0, sig: '', source: 'resume', rel: { repo: 'acme/x', stage: 'tag', baselineTags: [], deadline: 9e15, armedAt: 0, noRunGrace: false } },
    ] }]])
    const r = engineRig(gh, {}, store)
    await r.engine.boot()
    expect(r.engine.snapshot().items).toEqual([])
  })

  test('an item whose poll throws costs only itself: the others still change and toast', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [running('ci')] }) } })
    const bad = { id: 'rel:acme/widget@1', repo: 'acme/widget', phase: 'release', armedAt: 0, lastTransitionAt: 0, errorStreak: 0, confirmed: true, touchedAt: 0, sig: '', source: 'resume', rel: { repo: 'acme/widget', workflow: { id: 1, name: 'Release', path: '.github/workflows/release.yml' }, stage: 'tag', baselineTags: 5, mergeSha: 'a'.repeat(40), deadline: 9e15, armedAt: 0, noRunGrace: false } }
    const store = new Map<string, unknown>([[`${KEY_PREFIX}session-1`, { savedAt: 0, items: [bad] }]])
    const r = engineRig(gh, {}, store)
    await r.engine.boot()
    await r.engine.watchPr('12')
    ;(gh.prs[KEY] as FixturePr).checks = [passed('ci')]
    await r.tick()
    expect(r.kinds()).toEqual(['checks-passed'])
    expect(r.item('rel:acme/widget@1')?.errorStreak).toBeGreaterThan(0)
  })
})

describe('bug 8: parsers', () => {
  const reqs = (command: string, out = '') => bashPrRequests(command, bashResult(out))
  test('gh -R before the subcommand', () => {
    expect(reqs('gh -R o/r pr view 12')).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 12 }])
    expect(reqs('gh --repo=o/r pr checks 3')).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 3 }])
  })
  test('subshells', () => {
    expect(reqs('(gh pr merge 12 -R o/r)')).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 12 }])
    expect(reqs('x=$(gh pr merge 12 -R o/r)')).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 12 }])
  })
  test('gh api …/pulls/N/merge -X PUT is a merge; a GET is not', () => {
    expect(reqs('gh api repos/o/r/pulls/12/merge -X PUT -f merge_method=squash')).toMatchObject([{ kind: 'pr', repo: 'o/r', pr: 12 }])
    expect(reqs('gh api repos/o/r/pulls/12/merge --method=PUT')).toHaveLength(1)
    expect(reqs('gh api repos/o/r/pulls/12/merge')).toEqual([])
  })
  test('heredoc bodies are data', () => {
    expect(reqs('cat <<EOF\ngh pr merge 55 -R o/r\nEOF')).toEqual([])
    expect(reqs("cat <<-'X' > notes.md\n\tgh pr merge 55 -R o/r\n\tX\ngh pr view 7 -R o/r")).toMatchObject([{ pr: 7 }])
    const quoted = reqs('gh pr create --body "$(cat <<\'EOF\'\nsee gh pr merge 99\nEOF\n)"', `${URL12}\n`)
    expect(quoted[0]).toMatchObject({ kind: 'pr', pr: 12, source: 'pr-create' })
    expect(quoted.some(q => 'pr' in q && q.pr === 99)).toBe(false)
  })
  test('M22: a pipe splits commands', () => {
    expect(reqs('echo x | gh pr view 12 -R o/r')).toMatchObject([{ kind: 'pr', pr: 12 }])
  })
  test('M29: at most 5 URLs from one output', () => {
    const out = Array.from({ length: 7 }, (_, n) => `https://github.com/o/r/pull/${n + 1}`).join('\n')
    expect(reqs('gh pr list -R o/r --json url', out).filter(r => r.source === 'url')).toHaveLength(0)
    expect(reqs('gh pr view 1 -R o/r', out).filter(r => r.source === 'url')).toHaveLength(5)
  })
  test('M37: gh pr create --web creates nothing here', () => {
    expect(parsePrCommands('gh pr create --web')).toEqual([])
  })
  test('typed merged: "merged 178" names the PR; "merged?" is a question', () => {
    expect(typedMerged('merged 178')).toEqual({ matched: true, pr: 178 })
    expect(typedMerged('merged?').matched).toBe(false)
    expect(typedMerged('merged ?').matched).toBe(false)
    expect(typedMerged('merged').matched).toBe(true)
  })
  test('cd ~/x and cd sub are resolved before gh runs (no shell)', async () => {
    const r = engineRig(github())
    r.engine.afterTool({ tool: 'Bash', command: 'cd ~/src/widget && gh pr view feat/thing', result: bashResult('') })
    await r.settle()
    r.engine.afterTool({ tool: 'Bash', command: 'cd sub && gh pr view feat/thing', result: bashResult('') })
    await r.settle()
    const viewCwds = r.cwds.filter((_, n) => r.runs[n]?.startsWith('gh pr view'))
    expect(viewCwds).toEqual(['/home/tester/src/widget', '/work/widget/sub'])
  })
})

describe('surviving mutations', () => {
  const view = (p: FixturePr) => {
    const node = {
      state: 'OPEN', isDraft: false, mergeable: p.mergeable ?? 'MERGEABLE', mergeStateStatus: p.mergeStateStatus ?? 'CLEAN',
      reviewDecision: p.reviewDecision ?? null, reviewRequests: { totalCount: p.reviewRequests ?? 0 },
      reviewThreads: { nodes: [] }, latestReviews: { nodes: (p.reviews ?? []).map(state => ({ state })) },
    }
    return classify(node, checksOfContexts(p.checks), false)
  }
  test('M4: reviewDecision CHANGES_REQUESTED alone means changes', () => {
    expect(view(openPr({ reviewDecision: 'CHANGES_REQUESTED', reviews: [], reviewRequests: 0 })).review).toBe('changes')
  })
  test('M27: an approving review with no reviewDecision (no required reviews) is approved', () => {
    expect(view(openPr({ reviewDecision: null, reviews: ['APPROVED'], reviewRequests: 0, mergeStateStatus: 'CLEAN', checks: [passed('ci')] })).review).toBe('approved-ready')
  })
  test('M1/M2: ACTION_REQUIRED is pending, STARTUP_FAILURE is a failure', () => {
    expect(view(openPr({ checks: [{ name: 'deploy', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }] })).ci).toBe('running')
    expect(view(openPr({ checks: [{ name: 'boot', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }] })).failing).toEqual(['boot'])
  })
  test('M6: only semver:major|minor|patch gate a release', async () => {
    expect(hasSemverLabel(['semver:none'])).toBe(false)
    const gh = github()
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    mergePr(gh, KEY, { labels: ['semver:skip'] })
    r.engine.onPrompt('merged', 'composer')
    await r.settle()
    expect(outcome(r)).toEqual({ kind: 'no-semver-label' })
  })
  test('M13: a dispatch follows the first run created after it, not a later one', async () => {
    const gh = github()
    const r = engineRig(gh)
    r.at(100_000)
    r.engine.afterTool({ tool: 'Bash', command: 'gh workflow run release.yml -R acme/widget', result: bashResult('') })
    await r.settle()
    releaseRun(gh, { id: 51, event: 'workflow_dispatch', status: 'in_progress', created_at: iso(101_000) })
    releaseRun(gh, { id: 52, event: 'workflow_dispatch', status: 'queued', created_at: iso(150_000) })
    await r.tick()
    expect(r.engine.snapshot().items[0]?.release?.runUrl).toBe('https://github.com/acme/widget/actions/runs/51')
  })
  test('M16: past 30 watches the longest-idle goes, not the newest', async () => {
    const prs: Record<string, FixturePr> = {}
    for (let n = 1; n <= 31; n++) prs[`acme/widget#${n}`] = openPr({ checks: [passed('ci')], branch: `b${n}` })
    const r = engineRig(github({ prs }))
    await r.engine.watchPr(Array.from({ length: 30 }, (_, n) => n + 1).join(' '))
    r.at(60_000)
    await r.engine.watchPr('31')
    const ids = r.engine.snapshot().items.map(i => i.id)
    expect(ids).toContain('pr:acme/widget#31')
    expect(ids).toHaveLength(30)
  })
  test('M19: a quiet PR touched recently is not dropped as idle', async () => {
    const gh = github({ prs: { [KEY]: openPr({ checks: [passed('ci')] }) } })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    r.at(23 * 60 * 60_000)
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr view 12 -R acme/widget', result: bashResult('') })
    await r.settle()
    await r.tick(2 * 60 * 60_000)
    expect(r.item(PR_ID)).toBeDefined()
  })
  test('M38: an offer stored past its TTL comes back dismissed', async () => {
    const store = new Map<string, unknown>([[`${KEY_PREFIX}session-1`, { savedAt: 0, items: [
      { id: PR_ID, repo: 'acme/widget', pr: 12, phase: 'done', armedAt: 0, doneAt: 0, lastTransitionAt: 0, errorStreak: 0, confirmed: true, touchedAt: 0, sig: '', source: 'command', outcome: { kind: 'published', tag: 'v1' },
        deploy: { target: { appRepo: 'acme/widget', deployRepo: 'acme/deploy', path: 'x' }, version: 'v1', state: 'offered' } },
    ] }]])
    const r = engineRig(github(), {}, store)
    r.at(60 * 60_000)
    await r.engine.boot()
    expect(r.item(PR_ID)?.deploy?.state).toBe('dismissed')
  })
  test('M26: a closed PR seen in passing is not armed', async () => {
    const r = engineRig(github({ prs: { [KEY]: openPr({ state: 'CLOSED' }) } }))
    r.engine.afterTool({ tool: 'Bash', command: 'gh pr view 12 -R acme/widget', result: bashResult('') })
    await r.settle()
    expect(r.engine.snapshot().items).toEqual([])
  })
  test('M32: a new tag whose ancestry could not be read is not taken', async () => {
    const gh = github()
    const r = await createdAndMerged(gh)
    releaseRun(gh, { status: 'completed', conclusion: 'success', at: r.now() })
    cutRelease(gh)
    gh.broken = ['/compare/']
    await r.tick()
    expect(r.item(PR_ID)?.release?.stage).toBe('tag')
    gh.broken = []
    await r.tick()
    expect(r.item(PR_ID)?.release?.tag).toBe('v1.2.3')
  })
  test('M36: a release already covered costs no package or tag reads', async () => {
    const gh = github()
    const r = engineRig(gh)
    releaseRun(gh, { id: 100, status: 'in_progress' })
    await r.engine.watchRelease('acme/widget')
    const n = r.runs.length
    r.engine.afterTool({ tool: 'Bash', command: 'gh run watch 100 -R acme/widget', result: bashResult('') })
    await r.settle()
    const extra = r.runs.slice(n)
    expect(extra.some(x => x.includes('/packages/') || x.includes('refs('))).toBe(false)
    expect(RELEASE_SHA).toBe('c'.repeat(40))
  })
})
