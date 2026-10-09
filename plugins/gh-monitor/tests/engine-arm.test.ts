import { describe, expect, test } from 'claude-code/testing'

import { parsePrCommands, parsePush, parseReleaseCommands, parseReleaseWatchCommand, mergedLinesIn, typedMerged, parseWatchPrArgs, parseWatchReleaseArgs } from '../hooks/engine/arm'
import {
  bashResult,
  engineRig,
  github,
  iso,
  KEY,
  mergePr,
  monitorResult,
  openPr,
  PR_ID,
  REPO,
  releaseRun,
  RELEASE_WF,
  CI_WF,
  MERGE_SHA,
} from './fixtures/github'
import type { Rig } from './fixtures/github'

const URL12 = 'https://github.com/acme/widget/pull/12'
const bash = async (r: Rig, command: string, result: unknown = bashResult('')) => {
  await r.engine.beforeTool({ tool: 'Bash', command })
  r.engine.afterTool({ tool: 'Bash', command, result })
  await r.settle()
}
const monitor = async (r: Rig, command: string, taskId = 'task-1') => {
  r.engine.afterTool({ tool: 'Monitor', command, result: monitorResult(taskId) })
  await r.settle()
}
const ids = (r: Rig) => r.engine.snapshot().items.map(i => i.id)
const graphqlRuns = (r: Rig) => r.runs.filter(x => x.includes('...PR')).length

describe('route 1: PRs the session touches', () => {
  test('gitOperation.pr arms first (no output parsing needed)', async () => {
    const r = engineRig(github())
    await bash(r, 'gh pr create --fill', bashResult('', { gitOperation: { pr: { number: 12, url: URL12, action: 'created' } } }))
    expect(r.item(PR_ID)?.source).toBe('pr-create')
    expect(r.item(PR_ID)?.prView?.ci).toBe('starting')
  })

  test('gh pr create: the URL it prints', async () => {
    const r = engineRig(github())
    await bash(r, 'cd /work/widget && gh pr create --title "x" --body "y"', bashResult(`Creating pull request\n${URL12}\n`))
    expect(r.item(PR_ID)?.source).toBe('pr-create')
  })

  test('gh pr view 12 -R acme/widget', async () => {
    const r = engineRig(github())
    await bash(r, 'gh pr view 12 -R acme/widget --json state')
    expect(r.item(PR_ID)?.source).toBe('pr-cmd')
  })

  test('gh pr checks with a URL', async () => {
    const r = engineRig(github())
    await bash(r, `gh pr checks ${URL12} --watch`)
    expect(ids(r)).toEqual([PR_ID])
  })

  test('bare gh pr merge --delete-branch: the PR is read before the merge switches branches', async () => {
    const gh = github()
    const r = engineRig(gh)
    const command = 'gh pr merge --squash --delete-branch'
    await r.engine.beforeTool({ tool: 'Bash', command })
    expect(r.runs).toEqual(['gh pr view --json number,url,state'])
    mergePr(gh)
    gh.currentBranch = 'main' // --delete-branch moved us
    r.engine.afterTool({ tool: 'Bash', command, result: bashResult('✓ Squashed and merged') })
    await r.settle()
    expect(r.item(PR_ID)?.phase).toBe('release')
    expect(r.kinds()).toEqual(['merged'])
  })

  test('git push of a branch with an open PR arms it; no PR or a closed one does not', async () => {
    const gh = github()
    const r = engineRig(gh)
    await bash(r, 'git push origin feat/none')
    expect(ids(r)).toEqual([])
    await bash(r, 'git push -u origin feat/thing')
    expect(r.item(PR_ID)?.source).toBe('push')

    const gh2 = github({ prs: { [KEY]: openPr({ state: 'CLOSED' }) } })
    const r2 = engineRig(gh2)
    await bash(r2, 'git push origin feat/thing')
    expect(ids(r2)).toEqual([])
  })

  test('Monitor ci-watch.py: -R + number, owner/repo#N, and every open PR', async () => {
    const gh = github({ prs: { [KEY]: openPr(), 'acme/widget#13': openPr({ branch: 'b13' }), 'acme/widget#14': openPr({ state: 'MERGED', mergedAt: iso(-86_400_000) }) } })
    const r = engineRig(gh)
    await monitor(r, 'python3 ~/.claude/plugins/git-tooling/scripts/ci-watch.py -R acme/widget 12')
    expect(ids(r)).toEqual([PR_ID])
    const r2 = engineRig(gh)
    await monitor(r2, 'ci-watch.py acme/widget#13')
    expect(ids(r2)).toEqual(['pr:acme/widget#13'])
    const r3 = engineRig(gh)
    await monitor(r3, 'cd /work/widget && /x/ci-watch.py')
    expect(r3.runs).toContain('gh pr list -R acme/widget --state open --limit 20 --json number')
    expect(ids(r3).sort()).toEqual([PR_ID, 'pr:acme/widget#13'])
  })

  test('an old merged PR viewed in passing is history: not armed', async () => {
    const gh = github()
    mergePr(gh, KEY, { at: -60 * 60_000 })
    const r = engineRig(gh)
    await bash(r, 'gh pr view 12 -R acme/widget')
    expect(ids(r)).toEqual([])
    expect(r.runs.some(x => x.includes('actions/workflows'))).toBe(false)
  })

  test('negatives: echo, --disable-auto, --web, a PR that does not exist', async () => {
    const r = engineRig(github())
    await bash(r, 'echo gh pr merge 12 -R acme/widget')
    await bash(r, 'gh pr merge 12 -R acme/widget --disable-auto')
    await bash(r, 'gh pr create --web')
    await bash(r, 'gh pr view 99 -R acme/widget')
    expect(ids(r)).toEqual([])
    expect(r.runs.filter(x => !x.includes('...PR'))).toEqual([])
  })

  test('denied, interrupted, backgrounded and never-ran calls arm nothing', async () => {
    const r = engineRig(github())
    const command = 'gh pr view 12 -R acme/widget'
    for (const result of [
      { deny: 'no' },
      { result: 'zsh: command not found: gh', isError: true },
      bashResult('', { interrupted: true }),
      bashResult('', { backgroundTaskId: 'bg1' }),
    ]) {
      r.engine.afterTool({ tool: 'Bash', command, result })
    }
    await r.settle()
    expect(r.runs).toEqual([])
  })
})

describe('route 2: ci-watch MERGED notifications', () => {
  test('PR #12: MERGED pokes the tracked PR at once (no wait for the next tick)', async () => {
    const gh = github()
    const r = engineRig(gh)
    await monitor(r, 'ci-watch.py -R acme/widget 12', 'task-7')
    expect(r.item(PR_ID)?.phase).toBe('pr')
    mergePr(gh)
    // not a busy PR (checks none yet but starting grace) — the poke must query now
    const before = graphqlRuns(r)
    r.engine.onPrompt('<task-notification>task-7: PR #12: MERGED — pull latest main and prune local branch feat/thing</task-notification>', 'task-notification')
    await r.settle()
    expect(graphqlRuns(r)).toBe(before + 1)
    expect(r.item(PR_ID)?.phase).toBe('release')
  })

  test('owner/repo#N with transitions before MERGED arms an untracked PR', async () => {
    const gh = github()
    mergePr(gh)
    const r = engineRig(gh)
    r.engine.onPrompt('acme/widget#12: checks passed,MERGED — pull latest main', 'task-notification')
    await r.settle()
    expect(r.item(PR_ID)?.source).toBe('merged-event')
    expect(r.item(PR_ID)?.phase).toBe('release')
  })

  test('a bare PR #N that matches nothing tracked is ignored', async () => {
    const r = engineRig(github())
    r.engine.onPrompt('PR #12: MERGED', 'task-notification')
    await r.settle()
    expect(r.runs).toEqual([])
  })

  test('parsing', () => {
    expect(mergedLinesIn('PR #12: MERGED — x\nfoo/bar#3: ready,MERGED — y\nPR #4: CLOSED')).toEqual([{ pr: 12 }, { repo: 'foo/bar', pr: 3 }])
  })
})

describe('route 3: typing "merged"', () => {
  test('"merged" pokes the most recently touched open PR', async () => {
    const gh = github({ prs: { [KEY]: openPr(), 'acme/widget#13': openPr({ branch: 'b13' }) } })
    const r = engineRig(gh)
    await bash(r, 'gh pr view 13 -R acme/widget')
    await bash(r, 'gh pr view 12 -R acme/widget')
    mergePr(gh)
    r.engine.onPrompt('merged', 'composer')
    await r.settle()
    expect(r.item(PR_ID)?.phase).toBe('release')
    expect(r.item('pr:acme/widget#13')?.phase).toBe('pr')
  })

  test('"i merged #12" and "merged <url>" name the PR', async () => {
    for (const text of ['i merged #12', `just merged ${URL12}`, 'merged acme/widget#12 thanks']) {
      const gh = github()
      mergePr(gh)
      const r = engineRig(gh)
      r.engine.onPrompt(text, 'composer')
      await r.settle()
      expect(r.item(PR_ID)?.source, text).toBe('typed-merged')
      expect(r.item(PR_ID)?.phase, text).toBe('release')
    }
  })

  test('nothing tracked: the cwd repo\'s last merged PR, only if it merged within 10 min', async () => {
    const gh = github({ mergedList: [{ number: 12, url: URL12, mergedAt: iso(0) }] })
    mergePr(gh)
    const r = engineRig(gh)
    r.at(9 * 60_000)
    r.engine.onPrompt('merged', 'bridge')
    await r.settle()
    expect(r.item(PR_ID)?.phase).toBe('release')

    const r2 = engineRig(gh)
    r2.at(11 * 60_000)
    r2.engine.onPrompt('merged', 'composer')
    await r2.settle()
    expect(ids(r2)).toEqual([])
  })

  test('not a typed merge: other words, other origins', async () => {
    const r = engineRig(github())
    await bash(r, 'gh pr view 12 -R acme/widget')
    const before = r.runs.length
    r.engine.onPrompt('is it merged yet?', 'composer')
    r.engine.onPrompt('merged', 'task-notification')
    r.engine.onPrompt('unmerged branches', 'composer')
    await r.settle()
    expect(r.runs.length).toBe(before)
    expect(typedMerged('Merged!').matched).toBe(true)
    expect(typedMerged('I just merged it').matched).toBe(true)
  })
})

describe('route 4: release polling and dispatch', () => {
  test('gh workflow run release.yml / Release / the id arm a dispatch watch; ci.yml does not', async () => {
    for (const wf of ['release.yml', 'Release', String(RELEASE_WF), '.github/workflows/release.yml']) {
      const r = engineRig(github())
      await bash(r, `gh workflow run ${wf} -R acme/widget`)
      const item = r.engine.snapshot().items[0]
      expect(item?.source, wf).toBe('dispatch')
      expect(item?.phase).toBe('release')
      expect(item?.pr).toBeUndefined()
    }
    const r = engineRig(github())
    await bash(r, 'gh workflow run ci.yml -R acme/widget')
    expect(ids(r)).toEqual([])
  })

  test('gh run watch <id>: only a release-workflow run', async () => {
    const gh = github()
    releaseRun(gh, { id: 100 })
    releaseRun(gh, { id: 101, workflow_id: CI_WF, name: 'CI', path: '.github/workflows/ci.yml' })
    const r = engineRig(gh)
    await bash(r, 'gh run watch 101 -R acme/widget')
    expect(ids(r)).toEqual([])
    await bash(r, 'gh run watch 100 --exit-status')
    expect(r.engine.snapshot().items[0]?.source).toBe('run-watch')
    expect(r.engine.snapshot().items[0]?.release?.runStatus).toBe('in_progress')
  })

  test('Monitor release-watch.py: repo with --tag, and --ghcr owner/pkg maps to the repo', async () => {
    const gh = github({ tags: [{ name: 'v1.2.3', sha: 'c'.repeat(40) }] })
    const r = engineRig(gh)
    await monitor(r, 'python3 /x/release-watch.py acme/widget --tag v1.2.3 --ghcr acme/charts/widget')
    const item = r.engine.snapshot().items[0]
    expect(item?.source).toBe('release-watch')
    expect(item?.release?.stage, 'tag exists: straight to the GitHub release').toBe('release')
    expect(item?.release?.wantTag).toBe('v1.2.3')

    const r2 = engineRig(github())
    releaseRun(r2.gh, { id: 100 })
    await monitor(r2, 'release-watch.py --ghcr acme/widget')
    expect(r2.engine.snapshot().items[0]?.repo).toBe(REPO)
  })

  test('gh release view: armed only while a release run is active or just finished', async () => {
    const r = engineRig(github())
    await bash(r, 'gh release view -R acme/widget')
    expect(ids(r), 'no run: silent').toEqual([])
    releaseRun(r.gh, { id: 100, status: 'in_progress' })
    await bash(r, 'gh release list --repo acme/widget --limit 3')
    expect(r.engine.snapshot().items[0]?.source).toBe('release-cmd')
  })

  test('a PR-less watch gives way to the PR watch on the same run', async () => {
    const gh = github()
    const r = engineRig(gh)
    releaseRun(gh, { id: 100 })
    await bash(r, 'gh run watch 100 -R acme/widget')
    mergePr(gh)
    r.engine.onPrompt('merged #12', 'composer')
    await r.settle()
    await r.tick()
    expect(r.engine.snapshot().items.map(i => i.pr)).toEqual([12])
  })

  test('parsing', () => {
    expect(parseReleaseCommands('gh workflow run release.yml -f bump=patch --ref main')).toMatchObject([{ kind: 'dispatch', workflow: 'release.yml' }])
    expect(parseReleaseCommands('gh run watch -i 5 123 -R a/b')).toMatchObject([{ kind: 'run', runId: 123, repo: 'a/b' }])
    expect(parseReleaseCommands('gh release view --web')).toEqual([])
    expect(parseReleaseWatchCommand('release-watch.py a/b --ghcr a/b --tag 1.0.0')).toMatchObject([{ repo: 'a/b', discover: false }])
    expect(parseReleaseWatchCommand('release-watch.py --bogus')).toBeUndefined()
  })
})

describe('route 5: commands', () => {
  test('/watch-pr forms', async () => {
    const gh = github({ prs: { [KEY]: openPr(), 'acme/widget#13': openPr({ branch: 'b13' }), 'acme/gadget#4': openPr() } })
    const r = engineRig(gh)
    expect(await r.engine.watchPr('12')).toBe('watching widget #12')
    expect(await r.engine.watchPr('acme/gadget#4')).toBe('watching gadget #4')
    expect(await r.engine.watchPr('https://github.com/acme/widget/pull/13')).toBe('watching widget #13')
    expect(await r.engine.watchPr('acme/widget 12')).toBe('watching widget #12')
    expect(await r.engine.watchPr('99')).toBe('not found: widget #99')
    expect(await r.engine.watchPr('')).toBe('usage: /watch-pr <N | owner/repo#N | URL>')
    expect(await r.engine.watchPr('banana')).toBe('not found: banana')
    expect(r.engine.snapshot().items.every(i => i.source === 'command')).toBe(true)
  })

  test('/watch-pr on an already-merged PR goes straight to the release check', async () => {
    const gh = github()
    mergePr(gh, KEY, { at: -2 * 60 * 60_000 })
    const r = engineRig(gh)
    expect(await r.engine.watchPr('12')).toBe('watching widget #12')
    expect(r.item(PR_ID)?.phase).toBe('release')
  })

  test('/watch-release --pr and --tag; bad input', async () => {
    const gh = github({ tags: [{ name: 'v2.0.0', sha: 'c'.repeat(40) }] })
    const r = engineRig(gh)
    expect(await r.engine.watchRelease('acme/widget --pr 12')).toBe('watching widget #12')
    expect(await r.engine.watchRelease('acme/widget --tag v2.0.0')).toBe('watching widget v2.0.0')
    const rel = r.engine.snapshot().items.find(i => i.pr === undefined)
    expect(rel?.release?.stage).toBe('release')
    expect(await r.engine.watchRelease('')).toBe('usage: /watch-release <owner/repo> [--pr N | --tag vX]')
    expect(await r.engine.watchRelease('acme/widget --pr x')).toBe('usage: /watch-release <owner/repo> [--pr N | --tag vX]')
    r.gh.workflows = []
    const r2 = engineRig(r.gh)
    expect(await r2.engine.watchRelease('acme/widget')).toBe('not found: widget has no release workflow')
  })

  test('arg parsing', () => {
    expect(parseWatchPrArgs('12 #13 a/b#4 a/b 5 x')).toEqual({ targets: [{ pr: 12 }, { pr: 13 }, { repo: 'a/b', pr: 4 }, { repo: 'a/b', pr: 5 }], bad: ['x'] })
    expect(parseWatchReleaseArgs('a/b --tag v1')).toEqual({ repo: 'a/b', tag: 'v1' })
    expect(parseWatchReleaseArgs('a/b --tag v1 --pr 2')).toBeUndefined()
  })
})

describe('route 6: sweep', () => {
  test('off by default: no runs listed', async () => {
    const gh = github()
    releaseRun(gh, { id: 100 })
    const r = engineRig(gh)
    await r.engine.watchPr('12')
    for (let i = 0; i < 4; i++) await r.tick()
    expect(r.runs.some(x => x.includes('status=in_progress'))).toBe(false)
  })

  test('on: an active release run in a configured repo is picked up', async () => {
    const gh = github()
    const r = engineRig(gh, { sweepRepos: 'acme/widget' })
    await r.engine.watchPr('12')
    releaseRun(gh, { id: 100, head_sha: MERGE_SHA })
    for (let i = 0; i < 4; i++) await r.tick()
    expect(r.engine.snapshot().items.find(i => i.source === 'sweep')?.release?.runStatus).toBe('in_progress')
  })
})

describe('parsers', () => {
  test('gh pr commands', () => {
    expect(parsePrCommands('GH_REPO=a/b gh pr merge --auto --squash')).toEqual([{ verb: 'merge', auto: true, repo: 'a/b' }])
    expect(parsePrCommands('cd /w && gh pr view feat/x --json url -q .url')).toEqual([{ verb: 'view', auto: false, cwd: '/w', selector: 'feat/x' }])
    expect(parsePrCommands('gh pr comment 5 --body "gh pr merge 6"')).toEqual([{ verb: 'comment', auto: false, selector: '5' }])
  })

  test('git push', () => {
    expect(parsePush('git push')).toEqual({})
    expect(parsePush('git -C /w push origin HEAD:feat')).toEqual({ cwd: '/w', branch: 'feat' })
    expect(parsePush('git push --tags')).toBeUndefined()
    expect(parsePush('git push origin :old')).toBeUndefined()
    expect(parsePush('git push origin refs/tags/v1')).toBeUndefined()
  })
})
