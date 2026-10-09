/**
 * The gh client: every GitHub read the engine makes, each one bounded by the
 * Host (which caps the call's time) and each failure folded into a value —
 * `undefined` for "could not read" (transient), `null` for "does not exist".
 * Nothing here throws.
 */
import { batchArgs, checksOfActionRuns, readBatch, recordOf } from './classify'
import type { Lookup, Target } from './classify'
import type { CheckView, Repo } from './model'
import { repoFromUrl, repoOf } from './shell'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], cwd?: string) => Promise<RunResult | null>

type Json = { ok: true; data: unknown } | { ok: false; notFound: boolean }

/** A repo's release workflow: id, display name, file path. */
export type Workflow = { id: number; name: string; path: string }

/** One workflow run, as the engine reads it. */
export type RunObs = {
  id: number
  workflowId?: number
  name?: string
  path?: string
  event?: string
  headSha?: string
  status: string
  conclusion: string | null
  url?: string
  createdAt?: number
  startedAt?: number
}

/** A tag: its commit, the commit's date when known, and whether it descends from the release commit. */
export type TagObs = { name: string; sha: string; date?: number; related?: boolean }
export type VersionObs = { digest: string; tags: readonly string[] }
export type Scope = 'users' | 'orgs'

/** The basenames treated as a release workflow when the configured one is absent (release-watch.py's list). */
const RELEASE_FILES = new Set(['release.yml', 'release.yaml', 'auto-release.yml', 'auto-release.yaml'])

/** The newest tags by commit date (the REST list is sorted by name, not age). */
export const TAGS_QUERY =
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){' +
  'refs(refPrefix:"refs/tags/",first:20,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){' +
  'nodes{name target{oid ... on Commit{committedDate} ... on Tag{target{oid ... on Commit{committedDate}}}}}}}}'

const basename = (path: string) => path.split('/').pop() ?? path
const timeOf = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) ? t : undefined
}

/** Picks the release workflow from a repo's list: the configured file, else a name/file that says release. */
export function pickReleaseWorkflow(list: readonly Workflow[], configured: string): Workflow | undefined {
  const want = configured.toLowerCase()
  return (
    list.find(w => basename(w.path).toLowerCase() === want) ??
    list.find(w => RELEASE_FILES.has(basename(w.path).toLowerCase())) ??
    list.find(w => /release/i.test(w.name))
  )
}

/** Whether a run (or a `gh workflow run` argument) names the release workflow. */
export function isReleaseWorkflowRef(ref: string, wf: Workflow): boolean {
  const r = ref.toLowerCase()
  return r === String(wf.id) || r === basename(wf.path).toLowerCase() || r === wf.name.toLowerCase()
}

export function runOf(value: unknown): RunObs | undefined {
  const o = recordOf(value)
  if (typeof o.status !== 'string' || typeof o.id !== 'number') return undefined
  const createdAt = timeOf(o.created_at)
  const startedAt = timeOf(o.run_started_at) ?? createdAt
  return {
    id: o.id,
    status: o.status,
    conclusion: typeof o.conclusion === 'string' ? o.conclusion : null,
    ...(typeof o.workflow_id === 'number' ? { workflowId: o.workflow_id } : {}),
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.path === 'string' ? { path: o.path } : {}),
    ...(typeof o.event === 'string' ? { event: o.event } : {}),
    ...(typeof o.head_sha === 'string' ? { headSha: o.head_sha } : {}),
    ...(typeof o.html_url === 'string' ? { url: o.html_url } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

/** Whether a run belongs to the release workflow: by id, else by file or display name. */
export function isReleaseRun(run: RunObs, wf: Workflow): boolean {
  if (run.workflowId !== undefined) return run.workflowId === wf.id
  if (run.path && basename(run.path).toLowerCase() === basename(wf.path).toLowerCase()) return true
  return run.name !== undefined && run.name.toLowerCase() === wf.name.toLowerCase()
}

export function createGitHub(run: Run) {
  const gh = async (args: readonly string[], cwd?: string): Promise<RunResult | null> => {
    try {
      return await run(['gh', ...args], cwd)
    } catch {
      return null
    }
  }

  async function api(path: string): Promise<Json> {
    const r = await gh(['api', path])
    if (!r) return { ok: false, notFound: false }
    if (r.exitCode !== 0) return { ok: false, notFound: /HTTP 404|Not Found/i.test(r.stderr + r.stdout) }
    try {
      return { ok: true, data: JSON.parse(r.stdout) }
    } catch {
      return { ok: false, notFound: false }
    }
  }

  async function json(args: readonly string[], cwd?: string): Promise<Record<string, unknown> | unknown[] | undefined> {
    const r = await gh(args, cwd)
    if (!r || r.exitCode !== 0) return undefined
    try {
      const v: unknown = JSON.parse(r.stdout)
      return Array.isArray(v) ? v : v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  /** One aliased GraphQL query for every target; gh prints the body (with `errors`) even on exit 1. */
  async function prs(targets: readonly Target[]): Promise<Lookup[]> {
    if (targets.length === 0) return []
    const r = await gh(batchArgs(targets))
    return readBatch(r?.stdout, targets.length)
  }

  /** The Actions fallback for a PR whose rollup hides checks. */
  async function actionChecks(repo: Repo, sha: string): Promise<CheckView[] | undefined> {
    const r = await gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])
    return r && r.exitCode === 0 ? checksOfActionRuns(r.stdout) : undefined
  }

  /** `gh pr view [selector] [-R repo] --json number,url,state` in `cwd`. */
  async function prView(
    selector: string | undefined,
    repo: Repo | undefined,
    cwd: string | undefined,
  ): Promise<{ repo: Repo; pr: number; state: string } | undefined> {
    const o = await json(
      ['pr', 'view', ...(selector !== undefined ? [selector] : []), ...(repo ? ['-R', repo] : []), '--json', 'number,url,state'],
      cwd,
    )
    const pr = recordOf(o)
    const prRepo = repoFromUrl(pr.url) ?? repo
    return typeof pr.number === 'number' && prRepo ? { repo: prRepo, pr: pr.number, state: String(pr.state ?? '') } : undefined
  }

  /** The open PRs of a repo (newest first, at most `limit`). */
  async function openPrs(repo: Repo, limit: number, cwd?: string): Promise<number[] | undefined> {
    const o = await json(['pr', 'list', '-R', repo, '--state', 'open', '--limit', String(limit), '--json', 'number'], cwd)
    if (!Array.isArray(o)) return undefined
    return o.map(x => recordOf(x).number).filter((n): n is number => typeof n === 'number')
  }

  /** The newest merged PR of a repo. */
  async function lastMerged(repo: Repo, cwd?: string): Promise<{ pr: number; mergedAt: number } | undefined> {
    const o = await json(['pr', 'list', '-R', repo, '--state', 'merged', '--limit', '1', '--json', 'number,url,mergedAt'], cwd)
    const first = recordOf(Array.isArray(o) ? o[0] : undefined)
    const mergedAt = timeOf(first.mergedAt)
    return typeof first.number === 'number' && mergedAt !== undefined ? { pr: first.number, mergedAt } : undefined
  }

  /** The repo a directory belongs to. */
  async function repoAt(cwd: string | undefined): Promise<Repo | undefined> {
    const o = await json(['repo', 'view', '--json', 'nameWithOwner'], cwd)
    const name = recordOf(o).nameWithOwner
    return typeof name === 'string' ? repoOf(name) : undefined
  }

  /** A repo's workflows; null when the repo is unknown, undefined when unreadable. */
  async function workflows(repo: Repo): Promise<Workflow[] | null | undefined> {
    const r = await api(`repos/${repo}/actions/workflows?per_page=100`)
    if (!r.ok) return r.notFound ? null : undefined
    const list = recordOf(r.data).workflows
    if (!Array.isArray(list)) return undefined
    return list.flatMap(w => {
      const o = recordOf(w)
      return typeof o.id === 'number' && typeof o.name === 'string' && typeof o.path === 'string'
        ? [{ id: o.id, name: o.name, path: o.path }]
        : []
    })
  }

  async function runList(path: string): Promise<RunObs[] | undefined> {
    const r = await api(path)
    if (!r.ok) return undefined
    const list = recordOf(r.data).workflow_runs
    return Array.isArray(list) ? list.flatMap(x => runOf(x) ?? []) : undefined
  }

  /** Runs for a commit (every workflow). */
  const runsForSha = (repo: Repo, sha: string) => runList(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`)
  /** A workflow's dispatched runs, newest first. */
  const dispatchedRuns = (repo: Repo, wf: Workflow) =>
    runList(`repos/${repo}/actions/workflows/${wf.id}/runs?event=workflow_dispatch&per_page=5`)
  /** A workflow's newest runs (any event), newest first. */
  const workflowRuns = (repo: Repo, wf: Workflow) => runList(`repos/${repo}/actions/workflows/${wf.id}/runs?per_page=5`)
  /** In-progress runs of a repo (the sweep). */
  const activeRuns = (repo: Repo) => runList(`repos/${repo}/actions/runs?status=in_progress&per_page=10`)

  /** One run by id; null when it doesn't exist. */
  async function runById(repo: Repo, id: number): Promise<RunObs | null | undefined> {
    const r = await api(`repos/${repo}/actions/runs/${id}`)
    if (!r.ok) return r.notFound ? null : undefined
    return runOf(r.data) ?? undefined
  }

  /** The repo's newest tags by commit date, each with its commit; undefined when unreadable. */
  async function newestTags(repo: Repo): Promise<TagObs[] | undefined> {
    const [owner, name] = repo.split('/') as [string, string]
    const r = await gh(['api', 'graphql', '-f', `query=${TAGS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`])
    if (!r || r.exitCode !== 0) return undefined
    let nodes: unknown
    try {
      nodes = recordOf(recordOf(recordOf(recordOf(JSON.parse(r.stdout)).data).repository).refs).nodes
    } catch {
      return undefined
    }
    if (!Array.isArray(nodes)) return undefined
    return nodes.flatMap(n => {
      const o = recordOf(n)
      const target = recordOf(o.target)
      // An annotated tag's target is the tag object; its commit is one level down.
      const commit = recordOf(target.target).oid !== undefined ? recordOf(target.target) : target
      const sha = commit.oid
      const date = timeOf(commit.committedDate)
      return typeof o.name === 'string' && typeof sha === 'string'
        ? [{ name: o.name, sha, ...(date !== undefined ? { date } : {}) }]
        : []
    })
  }

  /** Whether `head` is `base` or descends from it; undefined when the check failed. */
  async function descends(repo: Repo, base: string, head: string): Promise<boolean | undefined> {
    if (base === head) return true
    const r = await api(`repos/${repo}/compare/${base}...${head}`)
    if (!r.ok) return r.notFound ? false : undefined
    const status = recordOf(r.data).status
    return typeof status === 'string' ? status === 'ahead' || status === 'identical' : undefined
  }

  /** The GitHub Release for a tag: published, a draft, null (none), undefined (unreadable). */
  async function release(repo: Repo, tag: string): Promise<{ draft: boolean } | null | undefined> {
    const r = await api(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    if (r.ok) return { draft: recordOf(r.data).draft === true }
    return r.notFound ? null : undefined
  }

  /** Where a container package lives: users/ or orgs/; null when neither has it, undefined when unreadable. */
  async function packageScope(owner: string, name: string): Promise<Scope | null | undefined> {
    let unreadable = false
    for (const scope of ['users', 'orgs'] as const) {
      const r = await api(`${scope}/${owner}/packages/container/${encodeURIComponent(name)}`)
      if (r.ok) return scope
      if (!r.notFound) unreadable = true
    }
    return unreadable ? undefined : null
  }

  async function versions(scope: Scope, owner: string, name: string): Promise<VersionObs[] | undefined> {
    const r = await api(`${scope}/${owner}/packages/container/${encodeURIComponent(name)}/versions?per_page=30`)
    if (!r.ok || !Array.isArray(r.data)) return undefined
    return r.data.flatMap(v => {
      const o = recordOf(v)
      const tags = recordOf(recordOf(o.metadata).container).tags
      return typeof o.name === 'string'
        ? [{ digest: o.name, tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [] }]
        : []
    })
  }

  /** The commit a ref (a floating tag) points at. */
  async function commitOf(repo: Repo, ref: string): Promise<string | undefined> {
    const r = await api(`repos/${repo}/commits/${encodeURIComponent(ref)}`)
    const sha = r.ok ? recordOf(r.data).sha : undefined
    return typeof sha === 'string' ? sha : undefined
  }

  return {
    prs,
    actionChecks,
    prView,
    openPrs,
    lastMerged,
    repoAt,
    workflows,
    runsForSha,
    dispatchedRuns,
    workflowRuns,
    activeRuns,
    runById,
    newestTags,
    descends,
    release,
    packageScope,
    versions,
    commitOf,
  }
}

export type GitHubClient = ReturnType<typeof createGitHub>
