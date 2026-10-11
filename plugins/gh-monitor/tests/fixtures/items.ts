/**
 * Item / Snapshot builders for the UI's render tests: plain data shaped like
 * what the engine's snapshot() hands the UI, so the strings can be checked
 * without a scripted GitHub.
 */
import type { CheckView, Item, Outcome, PrView, ReleaseView, Snapshot } from '../../hooks/engine/model'

export const NOW = 1_800_000_000_000
export const REPO = 'acme/widget'
export const LONG_REPO = 'acme/a-very-long-repository-name-for-testing-elision'
export const LONG_VERSION = 'v123.456.789-rc.1+build.20261009'
export const LONG_CHECKS = Array.from({ length: 5 }, (_, i) => `ci-integration-suite-${i}-`.padEnd(40, 'z'))

export function pr(over: Partial<PrView> = {}): PrView {
  return {
    ci: 'running',
    passed: 3,
    failed: 0,
    pending: 4,
    total: 7,
    failing: [],
    checks: [],
    review: 'requested',
    unresolved: 0,
    isDraft: false,
    ...over,
  }
}

export function rel(over: Partial<ReleaseView> = {}): ReleaseView {
  return { stage: 'run', step: 1, total: 4, workflow: 'release.yml', deadline: NOW + 20 * 60_000, ...over }
}

export function item(over: Partial<Item> = {}): Item {
  const repo = over.repo ?? REPO
  const n = over.pr ?? 12
  return {
    id: `pr:${repo}#${n}`,
    repo,
    pr: n,
    source: 'pr-create',
    phase: 'pr',
    armedAt: NOW - 60_000,
    lastTransitionAt: NOW - 30_000,
    prView: pr(),
    errorStreak: 0,
    ...over,
  }
}

export function prItem(view: Partial<PrView>, over: Partial<Item> = {}): Item {
  return item({ prView: pr(view), ...over })
}

export function releaseItem(r: Partial<ReleaseView>, over: Partial<Item> = {}): Item {
  return item({
    phase: 'release',
    mergedAt: NOW - 90_000,
    prView: pr({ ci: 'passed', passed: 7, pending: 0, review: 'approved' }),
    release: rel(r),
    ...over,
  })
}

export function doneItem(outcome: Outcome, over: Partial<Item> = {}): Item {
  return item({
    phase: 'done',
    mergedAt: NOW - 5 * 60_000,
    doneAt: NOW - 60_000,
    outcome,
    ...over,
  })
}

export function offerItem(over: Partial<Item> = {}): Item {
  return doneItem(
    { kind: 'published', tag: 'v1.2.3', image: 'ghcr.io/acme/widget:v1.2.3', chart: '1.2.3' },
    {
      deploy: {
        target: { appRepo: REPO, deployRepo: 'acme/homelab-k8s', path: 'apps/widget/helmfile.yaml' },
        version: 'v1.2.3',
        image: 'ghcr.io/acme/widget:v1.2.3',
        chartVersion: '1.2.3',
        state: 'offered',
      },
      ...over,
    },
  )
}

export function snap(items: Item[], now = NOW): Snapshot {
  return { now, items }
}

export function check(name: string, state: CheckView['state'], over: Partial<CheckView> = {}): CheckView {
  return { name, state, ...over }
}

/** `n` distinct PR items in mixed states, for many-item width tests. */
export function many(n: number, repo = LONG_REPO): Item[] {
  const states: Partial<PrView>[] = [
    { ci: 'failing', failed: 2, failing: LONG_CHECKS },
    { ci: 'running' },
    { ci: 'passed', review: 'requested' },
    { ci: 'passed', review: 'approved-ready' },
  ]
  return Array.from({ length: n }, (_, i) =>
    i % 5 === 4
      ? releaseItem({ stage: 'release', step: 3, tag: LONG_VERSION }, { repo, pr: 100 + i, id: `pr:${repo}#${100 + i}` })
      : prItem(states[i % 4] as Partial<PrView>, { repo, pr: 100 + i, id: `pr:${repo}#${100 + i}`, lastTransitionAt: NOW - i }),
  )
}

/** The canonical "What it looks like" scenario (design §5.4). */
export function canonical(): Snapshot {
  return snap([
    prItem({ ci: 'failing', passed: 5, failed: 2, pending: 0, total: 7, failing: ['lint', 'test'], review: 'requested' }, {
      repo: 'acme/earmark',
      pr: 178,
      id: 'pr:acme/earmark#178',
    }),
    prItem({ ci: 'passed', passed: 7, pending: 0, total: 7, review: 'requested' }, {
      repo: 'acme/deck',
      pr: 32,
      id: 'pr:acme/deck#32',
    }),
    releaseItem(
      { stage: 'tag', step: 2, total: 4, runStatus: 'completed', artifacts: { image: { pkg: 'acme/widget' }, chart: { pkg: 'acme/charts/widget' } } },
      { pr: 12 },
    ),
    offerItem({ repo: 'acme/scrim', pr: 40, id: 'pr:acme/scrim#40', deploy: {
      target: { appRepo: 'acme/scrim', deployRepo: 'acme/homelab-k8s', path: 'apps/scrim/helmfile.yaml' },
      version: 'v0.47.9',
      image: 'ghcr.io/acme/scrim:v0.47.9',
      chartVersion: '0.47.9',
      state: 'offered',
    }, outcome: { kind: 'published', tag: 'v0.47.9', image: 'ghcr.io/acme/scrim:v0.47.9', chart: '0.47.9' } }),
  ])
}
