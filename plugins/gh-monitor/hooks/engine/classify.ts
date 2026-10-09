/**
 * Reading PRs the way ci-watch.py does: one aliased GraphQL query for every
 * watched PR, each node classified into CI and review state. Pure: takes
 * gh's stdout and returns plain data.
 */
import type { CheckView, CiState, PrView, Repo, ReviewState } from './model'

/** A PR to look up. */
export type Target = { repo: Repo; pr: number }

/** ci-watch.py's fields plus what the release stage needs (merge commit, base, labels). */
export const PR_FRAGMENT = `fragment PR on PullRequest {
  number
  title
  url
  state
  isDraft
  mergeable
  mergeStateStatus
  reviewDecision
  mergedAt
  mergeCommit { oid }
  baseRefName
  headRefName
  baseRepository { defaultBranchRef { name } }
  labels(first: 20) { nodes { name } }
  reviewRequests(first: 1) { totalCount }
  reviewThreads(first: 100) { nodes { isResolved } }
  latestReviews(first: 50) { nodes { state } }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}`

/** The aliased batch query for `n` PRs (`r0..r{n-1}`). */
export function batchQuery(n: number): string {
  const decls: string[] = []
  const bodies: string[] = []
  for (let i = 0; i < n; i++) {
    decls.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`)
    bodies.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { ...PR } }`)
  }
  return `query(${decls.join(', ')}) {\n${bodies.join('\n')}\n}\n${PR_FRAGMENT}`
}

/** The `gh` argv (without `gh`) of one batch query. */
export function batchArgs(targets: readonly Target[]): string[] {
  const args = ['api', 'graphql', '-f', `query=${batchQuery(targets.length)}`]
  targets.forEach((t, i) => {
    const [owner, name] = t.repo.split('/') as [string, string]
    args.push('-f', `o${i}=${owner}`, '-f', `n${i}=${name}`, '-F', `p${i}=${t.pr}`)
  })
  return args
}

export type Lookup = { node: Record<string, unknown> } | { gone: true } | { transient: true }

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Splits one batch reply into a lookup per target: a node, gone (NOT_FOUND), or transient. */
export function readBatch(stdout: string | undefined, n: number): Lookup[] {
  let data: unknown
  try {
    data = stdout ? JSON.parse(stdout) : undefined
  } catch {
    data = undefined
  }
  if (!data || typeof data !== 'object') return Array.from({ length: n }, () => ({ transient: true }))
  const d = recordOf(data)
  const gone = new Set<string>()
  for (const err of Array.isArray(d.errors) ? d.errors : []) {
    const e = recordOf(err)
    const path = Array.isArray(e.path) ? e.path : []
    if (e.type === 'NOT_FOUND' && typeof path[0] === 'string' && path[0].startsWith('r')) gone.add(path[0])
  }
  const dnode = recordOf(d.data)
  return Array.from({ length: n }, (_, i): Lookup => {
    const alias = `r${i}`
    const r = dnode[alias]
    const pr = r && typeof r === 'object' ? (r as Record<string, unknown>).pullRequest : undefined
    if (pr && typeof pr === 'object') return { node: pr as Record<string, unknown> }
    if (gone.has(alias)) return { gone: true }
    if (r && typeof r === 'object' && 'pullRequest' in r) return { gone: true }
    return { transient: true }
  })
}

type CheckKind = 'pass' | 'fail' | 'pending' | 'skip'

/** ci-watch.py's _classify_check ('ignore' is reported as 'skip'). */
export function classifyCheck(c: unknown): CheckKind {
  const o = recordOf(c)
  const up = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : '')
  const status = up(o.status)
  const conclusion = up(o.conclusion)
  const state = up(o.state)
  if (status) {
    if (status !== 'COMPLETED') return 'pending'
    if (conclusion === 'SUCCESS') return 'pass'
    if (['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(conclusion)) return 'fail'
    if (conclusion === 'ACTION_REQUIRED') return 'pending'
    return 'skip'
  }
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return 'skip'
}

/** The head commit of a PR node, and whether its rollup hid some checks (null nodes). */
export function headOf(node: Record<string, unknown>): { sha?: string; contexts: unknown[]; hidden: boolean } {
  const commits = recordOf(node.commits).nodes
  const commit = recordOf(recordOf(Array.isArray(commits) ? commits[0] : undefined).commit)
  const contexts = recordOf(recordOf(commit.statusCheckRollup).contexts).nodes
  const list = Array.isArray(contexts) ? contexts : []
  return {
    ...(typeof commit.oid === 'string' ? { sha: commit.oid } : {}),
    contexts: list,
    hidden: list.some(c => c === null),
  }
}

const timeOf = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) ? t : undefined
}

/** The rollup's checks as CheckViews, rollup order. */
export function checksOfContexts(contexts: readonly unknown[]): CheckView[] {
  const out: CheckView[] = []
  for (const c of contexts) {
    if (c === null || typeof c !== 'object') continue
    const o = recordOf(c)
    const name = typeof o.name === 'string' ? o.name : typeof o.context === 'string' ? o.context : ''
    if (!name) continue
    const url = typeof o.detailsUrl === 'string' ? o.detailsUrl : typeof o.targetUrl === 'string' ? o.targetUrl : undefined
    const startedAt = timeOf(o.startedAt)
    const completedAt = timeOf(o.completedAt)
    out.push({
      name,
      state: classifyCheck(o),
      ...(url ? { url } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    })
  }
  return out
}

/**
 * ci-watch.py's actions_check_counts over one page of workflow runs: the
 * fallback when the rollup hides check-runs this token can't read.
 */
export function checksOfActionRuns(stdout: string): CheckView[] | undefined {
  let runs: unknown
  try {
    runs = recordOf(JSON.parse(stdout)).workflow_runs
  } catch {
    return undefined
  }
  if (!Array.isArray(runs)) return undefined
  const seen = new Set<string>()
  const out: CheckView[] = []
  for (const r of runs) {
    const o = recordOf(r)
    if (typeof o.name !== 'string' || seen.has(o.name)) continue
    seen.add(o.name)
    const status = String(o.status ?? '')
    const conclusion = String(o.conclusion ?? '')
    const state: CheckView['state'] =
      status !== 'completed' || conclusion === 'action_required'
        ? 'pending'
        : conclusion === 'success'
          ? 'pass'
          : ['failure', 'timed_out', 'startup_failure'].includes(conclusion)
            ? 'fail'
            : 'skip'
    const url = typeof o.html_url === 'string' ? o.html_url : undefined
    out.push({ name: o.name, state, ...(url ? { url } : {}) })
  }
  return out
}

/**
 * Classifies a PR node (ci-watch.py's build_signature). `checks` are the
 * head's checks (rollup or Actions fallback); `checksGrace` is true while a
 * PR with no checks may still be about to get some.
 */
export function classify(node: Record<string, unknown>, checks: readonly CheckView[], checksGrace: boolean): PrView {
  let passed = 0
  let failed = 0
  let pending = 0
  const failing: string[] = []
  for (const c of checks) {
    if (c.state === 'pass') passed++
    else if (c.state === 'pending') pending++
    else if (c.state === 'fail') {
      failed++
      if (!failing.includes(c.name)) failing.push(c.name)
    }
  }
  const total = checks.length
  const ci: CiState =
    failed > 0
      ? 'failing'
      : pending > 0
        ? 'running'
        : total === 0
          ? checksGrace
            ? 'starting'
            : 'none'
          : passed === 0
            ? 'skipped'
            : 'passed'

  const mergeable = typeof node.mergeable === 'string' ? node.mergeable : 'UNKNOWN'
  const mergeState = typeof node.mergeStateStatus === 'string' ? node.mergeStateStatus : 'UNKNOWN'
  const threads = recordOf(node.reviewThreads).nodes
  const unresolved = Array.isArray(threads) ? threads.filter(t => recordOf(t).isResolved === false).length : 0
  const reviews = recordOf(node.latestReviews).nodes
  const changes = Array.isArray(reviews) && reviews.some(r => recordOf(r).state === 'CHANGES_REQUESTED')
  const approvedReview = Array.isArray(reviews) && reviews.some(r => recordOf(r).state === 'APPROVED')
  const requests = Number(recordOf(node.reviewRequests).totalCount) || 0
  const decision = node.reviewDecision
  const approved = decision === 'APPROVED' || (decision == null && approvedReview && !changes)
  const isDraft = node.isDraft === true

  const ready =
    pending === 0 &&
    failed === 0 &&
    requests === 0 &&
    !changes &&
    unresolved === 0 &&
    mergeable === 'MERGEABLE' &&
    !['BLOCKED', 'DIRTY', 'BEHIND', 'DRAFT', 'UNKNOWN'].includes(mergeState)

  const review: ReviewState =
    mergeable === 'CONFLICTING'
      ? 'conflict'
      : changes || decision === 'CHANGES_REQUESTED'
        ? 'changes'
        : isDraft
          ? 'draft'
          : unresolved > 0
            ? 'unresolved'
            : requests > 0 || (decision === 'REVIEW_REQUIRED' && !ready)
              ? 'requested'
              : ready
                ? approved
                  ? 'approved-ready'
                  : 'ready'
                : mergeState === 'BLOCKED'
                  ? 'blocked'
                  : mergeState === 'BEHIND'
                    ? 'behind'
                    : approved
                      ? 'approved'
                      : 'unknown'
  const head = headOf(node)
  return {
    ci,
    passed,
    failed,
    pending,
    total,
    failing,
    checks: [...checks],
    review,
    unresolved,
    isDraft,
    ...(head.sha ? { headSha: head.sha } : {}),
  }
}

/** The non-classification facts the engine needs from a PR node. */
export type PrFacts = {
  state: 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'
  number?: number
  title?: string
  url?: string
  mergedAt?: number
  mergeSha?: string
  base?: string
  defaultBranch?: string
  labels: string[]
}

export function factsOf(node: Record<string, unknown>): PrFacts {
  const state = node.state === 'OPEN' || node.state === 'MERGED' || node.state === 'CLOSED' ? node.state : 'UNKNOWN'
  const labels = recordOf(node.labels).nodes
  const mergeSha = recordOf(node.mergeCommit).oid
  const defaultBranch = recordOf(recordOf(node.baseRepository).defaultBranchRef).name
  const mergedAt = timeOf(node.mergedAt)
  return {
    state,
    ...(typeof node.number === 'number' ? { number: node.number } : {}),
    ...(typeof node.title === 'string' ? { title: node.title } : {}),
    ...(typeof node.url === 'string' ? { url: node.url } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    ...(typeof mergeSha === 'string' ? { mergeSha } : {}),
    ...(typeof node.baseRefName === 'string' ? { base: node.baseRefName } : {}),
    ...(typeof defaultBranch === 'string' ? { defaultBranch } : {}),
    labels: Array.isArray(labels)
      ? labels.map(l => recordOf(l).name).filter((n): n is string => typeof n === 'string')
      : [],
  }
}

/** Whether a PR carries a `semver:major|minor|patch` label (any case). */
export function hasSemverLabel(labels: readonly string[]): boolean {
  return labels.some(l => /^semver:(major|minor|patch)$/i.test(l.trim()))
}
