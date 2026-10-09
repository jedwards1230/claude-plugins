import { describe, expect, test } from 'claude-code/testing'

import {
  configOf,
  elide,
  formatElapsed,
  isCompleted,
  isFloatingTagStale,
  isRecentMerge,
  NO_RUN_GRACE_MS,
  parseFloatingTagRepos,
  parseMergeCommand,
  RELEASE_GRACE_MS,
  STATUS_MAX,
  stagesOf,
  stepRegistry,
  stepRelease,
  stepRun,
  stepTag,
  statusLineOf,
  statusTextOf,
  TAG_GRACE_MS,
  timeoutOf,
  toastTextOf,
} from '../hooks/release-ticker/logic'
import type { Watch } from '../hooks/release-ticker/logic'

const WATCH: Watch = {
  repo: 'acme/widget',
  pr: 12,
  mergeSha: 'm1',
  armedAt: 0,
  deadline: 20 * 60_000,
  stage: 'run',
  baselineTags: ['v1.2.2'],
}

describe('release-ticker logic', () => {
  test('parseMergeCommand reads the PR number and --repo / -R / URL / GH_REPO', () => {
    expect(parseMergeCommand('gh pr merge 12 --squash --repo acme/widget')).toEqual({
      repo: 'acme/widget',
      pr: '12',
      auto: false,
    })
    expect(parseMergeCommand('gh pr merge -R github.com/acme/widget -s 12')).toEqual({
      repo: 'acme/widget',
      pr: '12',
      auto: false,
    })
    expect(parseMergeCommand('gh pr merge --repo=acme/widget #7')).toEqual({ repo: 'acme/widget', pr: '7', auto: false })
    expect(parseMergeCommand('gh pr merge https://github.com/acme/widget/pull/34 --merge')).toEqual({
      repo: 'acme/widget',
      pr: '34',
      auto: false,
    })
    expect(parseMergeCommand('GH_REPO=acme/widget gh pr merge 5')).toEqual({ repo: 'acme/widget', pr: '5', auto: false })
  })

  test('parseMergeCommand skips flag values, keeps --auto, a leading cd and a branch selector', () => {
    expect(parseMergeCommand('cd /src/widget && gh pr merge --auto -b "merge it" -t subj feat/x -d')).toEqual({
      cwd: '/src/widget',
      pr: 'feat/x',
      auto: true,
    })
    expect(parseMergeCommand("gh pr merge --squash --body 'a; b && c'")).toEqual({ auto: false })
    expect(parseMergeCommand('git push && gh pr merge 3 && git pull')).toEqual({ pr: '3', auto: false })
  })

  test('parseMergeCommand ignores non-merges', () => {
    expect(parseMergeCommand('gh pr view 12')).toBeUndefined()
    expect(parseMergeCommand('echo gh pr merge 12')).toBeUndefined()
    expect(parseMergeCommand('gh pr merge 12 --disable-auto')).toBeUndefined()
    expect(parseMergeCommand('git merge main')).toBeUndefined()
  })

  test('parseFloatingTagRepos takes owner/repo:tag entries and drops junk', () => {
    expect(parseFloatingTagRepos(['acme/workflows:v1', 'acme/actions:v2', 'nope', 'a/b:', ':v1'])).toEqual([
      { repo: 'acme/workflows', tag: 'v1' },
      { repo: 'acme/actions', tag: 'v2' },
    ])
    expect(parseFloatingTagRepos('acme/workflows:v1, acme/actions:latest')).toEqual([
      { repo: 'acme/workflows', tag: 'v1' },
      { repo: 'acme/actions', tag: 'latest' },
    ])
    expect(parseFloatingTagRepos('["acme/workflows:v1"]'), 'a JSON array saved as one string').toEqual([
      { repo: 'acme/workflows', tag: 'v1' },
    ])
    expect(parseFloatingTagRepos(undefined)).toEqual([])
  })

  test('configOf fills defaults and rejects junk', () => {
    expect(configOf({})).toEqual({ releaseWorkflow: 'release.yml', registry: 'ghcr.io', floatingTags: [], timeoutMs: 1_200_000 })
    expect(
      configOf({ releaseWorkflow: '.github/workflows/publish.yaml', registry: 'ghcr.io/', timeoutMin: 0, floatingTagRepos: [] }),
    ).toEqual({ releaseWorkflow: 'publish.yaml', registry: 'ghcr.io', floatingTags: [], timeoutMs: 1_200_000 })
    expect(configOf({ timeoutMin: '45' }).timeoutMs).toBe(45 * 60_000)
  })

  test('stepRun: waits, follows the status, gives up quietly without a run, fails on a bad conclusion', () => {
    expect(stepRun(WATCH, null, NO_RUN_GRACE_MS - 1).done).toBeUndefined()
    expect(stepRun(WATCH, null, NO_RUN_GRACE_MS).done).toEqual({ kind: 'no-run' })
    expect(stepRun({ ...WATCH, floatingTag: 'v1' }, null, NO_RUN_GRACE_MS).done, 'floating repos wait').toBeUndefined()
    expect(stepRun(WATCH, undefined, 1e9).watch).toBe(WATCH)
    expect(stepRun(WATCH, { status: 'in_progress', conclusion: null }, 1).watch.runStatus).toBe('in_progress')
    expect(stepRun(WATCH, { status: 'completed', conclusion: 'success' }, 7).watch).toMatchObject({ stage: 'tag', runDoneAt: 7 })
    expect(stepRun(WATCH, { status: 'completed', conclusion: 'skipped' }, 7).done).toEqual({ kind: 'no-release' })
    expect(stepRun(WATCH, { status: 'completed', conclusion: 'cancelled' }, 7).done).toEqual({
      kind: 'failed',
      conclusion: 'cancelled',
    })
  })

  test('stepRun: timed_out, startup_failure and action_required end as failed', () => {
    for (const conclusion of ['timed_out', 'startup_failure', 'action_required', 'failure']) {
      expect(stepRun(WATCH, { status: 'completed', conclusion }, 7).done, conclusion).toEqual({ kind: 'failed', conclusion })
    }
  })

  test('parseMergeCommand reads past redirections and a trailing &', () => {
    expect(parseMergeCommand('gh pr merge 12 --squash 2>&1')).toEqual({ pr: '12', auto: false })
    expect(parseMergeCommand('gh pr merge 12 --squash 2>&1 | tail -n 3')).toEqual({ pr: '12', auto: false })
    expect(parseMergeCommand('gh pr merge --squash > merge.log')).toEqual({ auto: false })
    expect(parseMergeCommand('gh pr merge --squash >merge.log 2> err.log')).toEqual({ auto: false })
    expect(parseMergeCommand('gh pr merge 7 &>/dev/null')).toEqual({ pr: '7', auto: false })
    expect(parseMergeCommand('gh pr merge 7 >>log')).toEqual({ pr: '7', auto: false })
    expect(parseMergeCommand('gh pr merge 7 &')).toEqual({ pr: '7', auto: false })
  })

  test('timeoutOf: a watch at the registry stage is published without a digest', () => {
    expect(timeoutOf(WATCH)).toEqual({ kind: 'timeout' })
    expect(timeoutOf({ ...WATCH, stage: 'registry', tag: 'v1.2.3' })).toEqual({ kind: 'published', tag: 'v1.2.3', noDigest: true })
    expect(toastTextOf({ ...WATCH, stage: 'registry' }, { kind: 'published', tag: 'v1.2.3', noDigest: true }, configOf({}))).toBe(
      'acme/widget #12: v1.2.3 published (GitHub release; no ghcr.io image after 20 min)',
    )
  })

  test('isRecentMerge: within 5 minutes of now, tolerating a little clock skew', () => {
    const now = Date.parse('2026-01-01T00:10:00Z')
    expect(isRecentMerge('2026-01-01T00:06:00Z', now)).toBe(true)
    expect(isRecentMerge('2026-01-01T00:04:00Z', now)).toBe(false)
    expect(isRecentMerge('2026-01-01T00:11:00Z', now), 'a minute of skew').toBe(true)
    expect(isRecentMerge(undefined, now)).toBe(false)
    expect(isRecentMerge('junk', now)).toBe(false)
  })

  test('stepTag: a new tag (the merge commit first) or no release after the grace', () => {
    const atTag: Watch = { ...WATCH, stage: 'tag', runDoneAt: 0 }
    const tags = [
      { name: 'v9', sha: 'x' },
      { name: 'v1.2.3', sha: 'm1' },
      { name: 'v1.2.2', sha: 'old' },
    ]
    expect(stepTag(atTag, tags, 1).watch).toMatchObject({ stage: 'release', tag: 'v1.2.3', tagSha: 'm1' })
    expect(stepTag(atTag, [{ name: 'v1.2.3', sha: 'r1', related: true }], 1).watch, 'a release commit after the merge').toMatchObject({
      stage: 'release',
      tag: 'v1.2.3',
      tagSha: 'r1',
    })
    const skipped = stepTag(atTag, [{ name: 'nightly', sha: 'x', related: false }, { name: 'v9', sha: 'y' }], 1)
    expect(skipped.watch.stage, 'unrelated or unverified: no pick').toBe('tag')
    expect(skipped.watch.baselineTags, 'an unrelated tag is not checked again').toEqual(['v1.2.2', 'nightly'])
    expect(stepTag(atTag, [{ name: 'v1.2.2', sha: 'old' }], TAG_GRACE_MS - 1).done).toBeUndefined()
    expect(stepTag(atTag, [{ name: 'v1.2.2', sha: 'old' }], TAG_GRACE_MS).done).toEqual({ kind: 'no-release' })
    expect(TAG_GRACE_MS, 'the post-run tag wait is short').toBeLessThanOrEqual(90_000)
  })

  test('stepRelease and stepRegistry', () => {
    const atRelease: Watch = { ...WATCH, stage: 'release', tag: 'v1.2.3', tagSeenAt: 0 }
    expect(stepRelease(atRelease, { draft: false }, 1).done).toEqual({ kind: 'published', tag: 'v1.2.3' })
    expect(stepRelease(atRelease, { draft: true }, 1).done).toBeUndefined()
    expect(stepRelease({ ...atRelease, pkg: { scope: 'users', owner: 'acme', name: 'widget' } }, { draft: false }, 1).watch.stage).toBe(
      'registry',
    )
    expect(stepRelease(atRelease, null, RELEASE_GRACE_MS).done).toEqual({ kind: 'tagged', tag: 'v1.2.3' })

    const atRegistry: Watch = { ...atRelease, stage: 'registry' }
    expect(stepRegistry(atRegistry, [{ digest: 'sha256:old', tags: ['1.2.2'] }]).done).toBeUndefined()
    expect(stepRegistry(atRegistry, [{ digest: 'sha256:new', tags: ['1.2.3'] }]).done).toEqual({
      kind: 'published',
      tag: 'v1.2.3',
      digest: 'sha256:new',
    })
    expect(stepRegistry(atRegistry, undefined).done, 'unqueryable: skipped').toEqual({ kind: 'published', tag: 'v1.2.3' })
  })

  test('isFloatingTagStale compares against the release commit, else the merge commit', () => {
    expect(isFloatingTagStale(WATCH, 'm1')).toBe(false)
    expect(isFloatingTagStale(WATCH, 'old')).toBe(true)
    expect(isFloatingTagStale({ ...WATCH, tagSha: 'r1' }, 'r1')).toBe(false)
    expect(isFloatingTagStale({ ...WATCH, tagSha: 'r1' }, 'm1')).toBe(true)
    expect(isFloatingTagStale(WATCH, undefined)).toBe(false)
  })

  test('isCompleted: denied, errored, interrupted and backgrounded calls did not complete', () => {
    expect(isCompleted({ result: { stdout: '', stderr: '', interrupted: false } })).toBe(true)
    expect(isCompleted({ deny: 'no' })).toBe(false)
    expect(isCompleted({ isError: true, result: 'Exit code 1' })).toBe(false)
    expect(isCompleted({ result: { stdout: '', stderr: '', interrupted: true } })).toBe(false)
    expect(isCompleted({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } })).toBe(false)
  })

  test('statusLineOf: one segment per watch when they fit, else the newest + N more; undefined when none', () => {
    const config = configOf({})
    expect(statusLineOf([], config, 0)).toBeUndefined()
    const widget: Watch = { ...WATCH, runStatus: 'queued' }
    expect(statusLineOf([widget], config, 0)).toBe('widget #12 · 1/3 · workflow queued')
    const gadget: Watch = { ...WATCH, repo: 'acme/gadget', pr: 3, stage: 'tag', armedAt: 5 }
    expect(statusLineOf([{ ...widget, repo: 'acme/w' }, { ...gadget, repo: 'acme/g', stage: 'run', runStatus: 'queued' }], config, 0)).toBe(
      'g #3 · 1/3 · workflow queued | w #12 · 1/3 · workflow queued',
    )
    expect(statusLineOf([widget, gadget], config, 0)).toBe('gadget #3 · 2/3 · workflow done, waiting for tag | +1 more')
  })

  test('statusTextOf: a step count and a plain phrase for every stage, 4 stages with a package, 3 without', () => {
    const config = configOf({})
    const pkg = { scope: 'users', owner: 'acme', name: 'widget' } as const
    const at = (w: Partial<Watch>, now = 0) => statusTextOf({ ...WATCH, ...w }, config, now)
    expect(stagesOf(WATCH)).toEqual(['run', 'tag', 'release'])
    expect(stagesOf({ ...WATCH, pkg })).toEqual(['run', 'tag', 'release', 'registry'])

    expect(at({})).toBe('widget #12 · 1/3 · waiting for workflow to start')
    expect(at({ floatingTag: 'v1' })).toBe('widget #12 · 1/3 · dispatch release.yml to move v1')
    expect(at({ runStatus: 'queued' })).toBe('widget #12 · 1/3 · workflow queued')
    expect(at({ runStatus: 'in_progress', runStartedAt: 0 }, 100_000)).toBe('widget #12 · 1/3 · workflow running 1m 40s')
    expect(at({ runStatus: 'in_progress' }, 40_000), 'no start time: elapsed since arming').toBe(
      'widget #12 · 1/3 · workflow running 40s',
    )
    expect(at({ stage: 'tag' })).toBe('widget #12 · 2/3 · workflow done, waiting for tag')
    expect(at({ stage: 'release', tag: 'v1.2.3' })).toBe('widget #12 · 3/3 · tagged v1.2.3, waiting for GitHub release')

    expect(at({ pkg })).toBe('widget #12 · 1/4 · waiting for workflow to start')
    expect(at({ pkg, stage: 'tag' })).toBe('widget #12 · 2/4 · workflow done, waiting for tag')
    expect(at({ pkg, stage: 'release', tag: 'v1.2.3' })).toBe('widget #12 · 3/4 · tagged v1.2.3, waiting for GitHub release')
    expect(at({ pkg, stage: 'registry', tag: 'v1.2.3' })).toBe('widget #12 · 4/4 · v1.2.3 released, waiting for image')
  })

  test('formatElapsed and elide', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(40_000)).toBe('40s')
    expect(formatElapsed(60_000)).toBe('1m')
    expect(formatElapsed(100_000)).toBe('1m 40s')
    expect(formatElapsed(65 * 60_000)).toBe('1h 5m')
    expect(formatElapsed(-5_000), 'clock skew clamps to zero').toBe('0s')
    expect(elide('abcdef', 6)).toBe('abcdef')
    expect(elide('abcdefg', 6)).toBe('abcde…')
  })

  test('every status line fits 82 columns with the 16-character ` ⚠ git-tooling: ` prefix', () => {
    const PREFIX = 16
    const pkg = { scope: 'users', owner: 'acme', name: 'a-really-long-repository-name-for-tests-x' } as const
    const long: Watch = { ...WATCH, repo: 'acme/a-really-long-repository-name-for-tests-x', pr: 12345 }
    const tag = 'v10.20.300-beta.12'
    const now = 3 * 3600_000 + 59 * 60_000 + 59_000
    for (const config of [configOf({}), configOf({ releaseWorkflow: 'publish-container-images-and-charts.yaml' })]) {
      for (const base of [WATCH, long]) {
        for (const w of [base, { ...base, pkg }]) {
          const stages: Watch[] = [
            w,
            { ...w, floatingTag: 'v1' },
            { ...w, runStatus: 'queued' },
            { ...w, runStatus: 'in_progress' },
            { ...w, stage: 'tag' },
            { ...w, stage: 'release', tag },
            ...(w.pkg ? [{ ...w, stage: 'registry' as const, tag }] : []),
          ]
          for (const s of stages) {
            const text = statusLineOf([s], config, now) as string
            expect(text.length + PREFIX, text).toBeLessThanOrEqual(82)
            expect(text, 'keeps the step count').toMatch(/ · \d\/[34] · /)
          }
          const multi = statusLineOf(stages, config, now) as string
          expect(multi.length + PREFIX, multi).toBeLessThanOrEqual(82)
        }
      }
    }
    expect(STATUS_MAX).toBe(66)
    expect(statusTextOf({ ...long, stage: 'release', tag }, configOf({}), 0)).toBe(
      'a-really-lo… #12345 · 3/3 · tagged v10.20.30…, waiting for release',
    )
    expect(statusTextOf({ ...long, runStatus: 'in_progress' }, configOf({}), 100_000)).toBe(
      'a-really-long-repository-n… #12345 · 1/3 · workflow running 1m 40s',
    )
  })

  test('toasts name the PR and say what happened in plain words', () => {
    const config = configOf({})
    const pkg = { scope: 'users', owner: 'acme', name: 'widget' } as const
    const toast = toastTextOf
    expect(toast(WATCH, { kind: 'published', tag: 'v1.2.3' }, config)).toBe('acme/widget #12: v1.2.3 published (GitHub release)')
    expect(toast({ ...WATCH, pkg }, { kind: 'published', tag: 'v1.2.3', digest: `sha256:${'d'.repeat(64)}` }, config)).toBe(
      'acme/widget #12: v1.2.3 published (GitHub release + ghcr.io image sha256:dddddddddddd)',
    )
    expect(toast({ ...WATCH, pkg }, { kind: 'published', tag: 'v1.2.3' }, config)).toBe(
      'acme/widget #12: v1.2.3 published (GitHub release; ghcr.io image not checked)',
    )
    expect(toast(WATCH, { kind: 'tagged', tag: 'v1.2.3' }, config)).toBe('acme/widget #12: tagged v1.2.3, but no GitHub release appeared')
    expect(toast(WATCH, { kind: 'failed', conclusion: 'failure' }, config)).toBe('acme/widget #12: release.yml failed (failure)')
    expect(toast(WATCH, { kind: 'no-release' }, config)).toBe(
      'acme/widget #12: release.yml ran but cut no new version (nothing to release)',
    )
    expect(toast({ ...WATCH, stage: 'tag' }, { kind: 'timeout' }, config)).toBe(
      'acme/widget #12: still waiting for the tag after 20 min — gave up',
    )
    expect(toast(WATCH, { kind: 'timeout' }, config)).toBe('acme/widget #12: still waiting for the workflow after 20 min — gave up')
    expect(toast(WATCH, { kind: 'no-run' }, config)).toBeUndefined()
  })
})
