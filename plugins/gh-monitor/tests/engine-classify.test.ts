import { describe, expect, test } from 'claude-code/testing'

import { batchArgs, checksOfActionRuns, checksOfContexts, classify, factsOf, readBatch } from '../hooks/engine/classify'
import { answer, failed, github, KEY, mergePr, openPr, passed, running, skipped } from './fixtures/github'
import type { FixturePr } from './fixtures/github'

function nodeFor(p: FixturePr) {
  const gh = github({ prs: { [KEY]: p } })
  const r = answer(gh, ['gh', ...batchArgs([{ repo: 'acme/widget', pr: 12 }])])
  const l = readBatch(r.stdout, 1)[0]
  if (!l || !('node' in l)) throw new Error('no node')
  return l.node
}
const view = (p: FixturePr, grace = false) => {
  const n = nodeFor(p)
  const contexts = (n.commits as { nodes: { commit: { statusCheckRollup: { contexts: { nodes: unknown[] } } | null } }[] }).nodes[0]
    ?.commit.statusCheckRollup?.contexts.nodes ?? []
  return classify(n, checksOfContexts(contexts), grace)
}

describe('classify', () => {
  test('CI states', () => {
    expect(view(openPr(), true).ci).toBe('starting')
    expect(view(openPr()).ci).toBe('none')
    expect(view(openPr({ checks: [passed('build'), running('test')] })).ci).toBe('running')
    const f = view(openPr({ checks: [failed('lint'), failed('test'), failed('lint'), running('x')] }))
    expect(f.ci).toBe('failing')
    expect(f.failing, 'deduped, rollup order').toEqual(['lint', 'test'])
    expect([f.passed, f.failed, f.pending, f.total]).toEqual([0, 3, 1, 4])
    expect(view(openPr({ checks: [passed('a'), skipped('b')] })).ci).toBe('passed')
    expect(view(openPr({ checks: [skipped('a')] })).ci).toBe('skipped')
    expect(view(openPr({ checks: [{ name: 'legacy', state: 'FAILURE' }] })).failing).toEqual(['legacy'])
  })

  test('review states', () => {
    expect(view(openPr({ mergeable: 'CONFLICTING' })).review).toBe('conflict')
    expect(view(openPr({ reviews: ['CHANGES_REQUESTED'] })).review).toBe('changes')
    expect(view(openPr({ isDraft: true, reviewRequests: 0 })).review).toBe('draft')
    expect(view(openPr({ unresolved: 2 })).review).toBe('unresolved')
    expect(view(openPr()).review).toBe('requested')
    const ready = openPr({ checks: [passed('ci')], reviewDecision: 'APPROVED', reviewRequests: 0, reviews: ['APPROVED'], mergeStateStatus: 'CLEAN' })
    expect(view(ready).review).toBe('approved-ready')
    expect(view({ ...ready, reviewDecision: null, reviews: [] }).review).toBe('ready')
    expect(view({ ...ready, mergeStateStatus: 'BEHIND' }).review).toBe('behind')
    expect(view(openPr({ reviewDecision: null, reviewRequests: 0 })).review).toBe('blocked')
  })

  test('check details for the pane: url and timings', () => {
    const checks = checksOfContexts([
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/1', startedAt: '1970-01-01T00:00:10Z', completedAt: '1970-01-01T00:01:00Z' },
      null,
      { context: 'deploy', state: 'PENDING', targetUrl: 'https://example.test/2' },
    ])
    expect(checks).toEqual([
      { name: 'ci', state: 'pass', url: 'https://example.test/1', startedAt: 10_000, completedAt: 60_000 },
      { name: 'deploy', state: 'pending', url: 'https://example.test/2' },
    ])
  })

  test('Actions fallback counts the newest run per workflow', () => {
    const c = checksOfActionRuns(JSON.stringify({ workflow_runs: [
      { name: 'CI', status: 'completed', conclusion: 'failure' },
      { name: 'CI', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'in_progress', conclusion: null },
    ] }))
    expect(c?.map(x => `${x.name}:${x.state}`)).toEqual(['CI:fail', 'Lint:pending'])
    expect(checksOfActionRuns('nope')).toBeUndefined()
  })

  test('facts: merge commit, base, default branch, labels', () => {
    const gh = github()
    mergePr(gh, KEY, { at: 5_000, labels: ['semver:minor', 'docs'], base: 'dev' })
    const f = factsOf(nodeFor(gh.prs[KEY] as FixturePr))
    expect(f.state).toBe('MERGED')
    expect(f.mergedAt).toBe(5_000)
    expect(f.mergeSha).toBe('a'.repeat(40))
    expect(f.base).toBe('dev')
    expect(f.defaultBranch).toBe('main')
    expect(f.labels).toEqual(['semver:minor', 'docs'])
  })

  test('readBatch: node, gone, transient, malformed', () => {
    const gh = github()
    const r = answer(gh, ['gh', ...batchArgs([{ repo: 'acme/widget', pr: 12 }, { repo: 'acme/widget', pr: 99 }])])
    const [a, b] = readBatch(r.stdout, 2)
    expect(a && 'node' in a).toBe(true)
    expect(b).toEqual({ gone: true })
    expect(readBatch('{oops', 2)).toEqual([{ transient: true }, { transient: true }])
    expect(readBatch(JSON.stringify({ data: { r0: null } }), 1)).toEqual([{ transient: true }])
  })
})
