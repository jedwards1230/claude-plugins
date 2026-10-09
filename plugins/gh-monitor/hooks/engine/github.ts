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

type Json = { ok: true; data: unknown } | { ok: false; notFound: boolean; forbidden?: boolean }

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

/** A container package and where it can be read. */
export type PackageRef =
  | { owner: string; name: string; via: 'api'; scope: Scope }
  | { owner: string; name: string; via: 'registry' }
export type Probe = PackageRef | 'absent' | 'unknown'

/** The manifest types a registry HEAD accepts: OCI index/manifest and their Docker equivalents. */
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

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

/**
 * A run that looks like a release by its workflow file (or, without a path,
 * its name): the fallback when the configured workflow only runs through
 * `workflow_call` (auto-release.yml calling release.yml).
 */
export function isReleaseLikeRun(run: RunObs): boolean {
  if (run.path) return /release/i.test(basename(run.path.replace(/@.*$/, '')))
  return run.name !== undefined && /release/i.test(run.name)
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
    if (r.exitCode !== 0) {
      const text = r.stderr + r.stdout
      return { ok: false, notFound: /HTTP 404|Not Found/i.test(text), forbidden: /HTTP 403|Forbidden|read:packages/i.test(text) }
    }
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
  const runsForSha = (repo: Repo, sha: string) => runList(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)
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

  /** A plain HTTPS read with curl (argv only, no shell), capped like every gh call. */
  async function curl(args: readonly string[]): Promise<RunResult | null> {
    try {
      return await run(['curl', '-sS', '--max-time', '15', ...args])
    } catch {
      return null
    }
  }

  /**
   * An anonymous pull token for a registry repository: the token; null when
   * the registry denies anonymous pulls (no public package of that name);
   * undefined when it could not be asked.
   */
  async function registryToken(registry: string, path: string): Promise<string | null | undefined> {
    const r = await curl([`https://${registry}/token?scope=repository:${path}:pull`])
    if (!r || r.exitCode !== 0) return undefined
    try {
      const o = recordOf(JSON.parse(r.stdout))
      if (typeof o.token === 'string' && o.token) return o.token
      const errors = Array.isArray(o.errors) ? o.errors : []
      return errors.some(e => /DENIED|UNAUTHORIZED|NAME_UNKNOWN/.test(String(recordOf(e).code))) ? null : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Where a container package can be read: through the Packages API (users/
   * or orgs/), anonymously through the registry (a public package read with a
   * token that lacks `read:packages`), 'absent', or 'unknown' when it could
   * not be told this time (asked again on a later poll).
   */
  async function probePackage(registry: string, owner: string, name: string): Promise<Probe> {
    let forbidden = false
    let transient = false
    for (const scope of ['users', 'orgs'] as const) {
      const r = await api(`${scope}/${owner}/packages/container/${encodeURIComponent(name)}`)
      if (r.ok) return { owner, name, via: 'api', scope }
      if (r.forbidden) forbidden = true
      else if (!r.notFound) transient = true
    }
    if (!forbidden && !transient) return 'absent'
    if (registry !== 'ghcr.io') return forbidden && !transient ? 'absent' : 'unknown'
    // The API couldn't say (a token without read:packages, or a blip): ask the registry anonymously.
    const token = await registryToken(registry, `${owner}/${name}`)
    if (typeof token === 'string') return { owner, name, via: 'registry' }
    // Denied anonymously: no public package. Without read:packages a private one can't be read at all.
    if (token === null && !transient) return 'absent'
    return 'unknown'
  }

  /**
   * The first of `tags` the registry has a manifest for, with its digest:
   * null when none of them exists yet, undefined when it could not be read.
   */
  async function registryVersion(
    registry: string,
    owner: string,
    name: string,
    tags: readonly string[],
  ): Promise<{ tag: string; digest?: string } | null | undefined> {
    const token = await registryToken(registry, `${owner}/${name}`)
    if (typeof token !== 'string') return undefined
    let unreadable = false
    for (const tag of tags) {
      const r = await curl([
        '-I',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        `Accept: ${MANIFEST_TYPES}`,
        `https://${registry}/v2/${owner}/${name}/manifests/${encodeURIComponent(tag)}`,
      ])
      const status = r && r.exitCode === 0 ? /^HTTP\/[\d.]+ (\d{3})/m.exec(r.stdout)?.[1] : undefined
      if (status === '200') {
        const digest = /^docker-content-digest:\s*(\S+)/im.exec(r?.stdout ?? '')?.[1]
        return { tag, ...(digest ? { digest } : {}) }
      }
      if (status !== '404') unreadable = true
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
    probePackage,
    registryVersion,
    versions,
    commitOf,
  }
}

export type GitHubClient = ReturnType<typeof createGitHub>
