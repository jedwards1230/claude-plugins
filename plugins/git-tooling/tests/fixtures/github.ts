/**
 * A scripted GitHub, answering the `gh` argv the Release Ticker runs from
 * mutable fields, so a test moves the release along by assigning them.
 * Nothing here touches the network.
 */

export const REPO = 'acme/widget'
export const PR = 12
export const MERGE_SHA = 'a'.repeat(40)
export const OLD_SHA = 'b'.repeat(40)
export const RELEASE_SHA = 'c'.repeat(40)
export const DIGEST = `sha256:${'d'.repeat(64)}`

export type Answer = { exitCode: number; stdout: string; stderr: string }

export type GitHub = {
  /** The PR's state after the merge command ran. */
  prState: 'MERGED' | 'OPEN' | 'CLOSED'
  /** When the PR merged (ISO); the test clocks start at 0, so the default is "just now". */
  mergedAt: string
  /** Whether the current branch has a PR (a merge with --delete-branch switches away). */
  currentBranchPr: boolean
  /** Whether the repo has the release workflow file. */
  hasWorkflow: boolean
  /** The newest release run for the merge commit; null before one exists. */
  run: { status: string; conclusion: string | null } | null
  /** Dispatched release runs, newest first (any head commit). */
  dispatchRuns: { head_sha: string; status: string; conclusion: string | null; created_at: string }[]
  /** Tags, newest commit first (as the GraphQL TAG_COMMIT_DATE order lists them). */
  tags: { name: string; sha: string }[]
  /** How a commit relates to the merge commit (`compare/MERGE...sha`); the default knows the fixture shas. */
  ancestry: Record<string, 'ahead' | 'behind' | 'diverged' | 'identical'>
  /** Release tags that have a published GitHub Release. */
  releases: string[]
  /** Whether the repo publishes a container package of its name (and under which scope). */
  pkg: 'users' | 'orgs' | null
  /** The package's versions. */
  versions: { digest: string; tags: string[] }[]
  /** Floating tag name -> the commit it points at. */
  floating: Record<string, string>
  /** Answers that fail for a reason other than 404 (argv substring -> true). */
  broken: string[]
}

export function github(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prState: 'MERGED',
    mergedAt: '1970-01-01T00:00:00Z',
    currentBranchPr: true,
    hasWorkflow: true,
    run: null,
    dispatchRuns: [],
    tags: [{ name: 'v1.2.2', sha: OLD_SHA }],
    ancestry: {},
    releases: ['v1.2.2'],
    pkg: null,
    versions: [{ digest: `sha256:${'e'.repeat(64)}`, tags: ['1.2.2', 'v1.2.2'] }],
    floating: {},
    broken: [],
    ...overrides,
  }
}

const ok = (data: unknown): Answer => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '' })
const notFound: Answer = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
const broken: Answer = { exitCode: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }

/** What `gh <argv...>` prints against this GitHub. */
export function answer(gh: GitHub, argv: readonly string[]): Answer {
  const line = argv.join(' ')
  if (gh.broken.some(b => line.includes(b))) return broken
  const prUrl = `https://github.com/${REPO}/pull/${PR}`

  if (line === 'gh pr view --json number,url') {
    return gh.currentBranchPr
      ? ok({ number: PR, url: prUrl })
      : { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' }
  }
  if (line.startsWith('gh pr view ')) {
    if (argv[3] !== String(PR)) return { exitCode: 1, stdout: '', stderr: `no pull requests found for branch "${argv[3]}"` }
    return ok({
      number: PR,
      url: prUrl,
      state: gh.prState,
      mergedAt: gh.prState === 'MERGED' ? gh.mergedAt : null,
      mergeCommit: gh.prState === 'MERGED' ? { oid: MERGE_SHA } : null,
    })
  }
  if (line.startsWith('gh api graphql ') && line.includes('refs(')) {
    if (!line.includes('owner=acme') || !line.includes('name=widget')) return notFound
    const nodes = gh.tags.slice(0, 20).map(t => ({ name: t.name, target: { oid: t.sha } }))
    return ok({ data: { repository: { refs: { nodes } } } })
  }

  const api = /^gh api (.+)$/.exec(line)?.[1]
  if (!api) return { exitCode: 1, stdout: '', stderr: `unscripted: ${line}` }

  const runs = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/release\.yml\/runs\?head_sha=([0-9a-f]+)&per_page=1$/.exec(api)
  if (runs) {
    if (!gh.hasWorkflow) return notFound
    const run = runs[1] === MERGE_SHA ? gh.run : null
    return ok({ total_count: run ? 1 : 0, workflow_runs: run ? [{ ...run, html_url: `https://github.com/${REPO}/actions/runs/1` }] : [] })
  }
  if (api === `repos/${REPO}/actions/workflows/release.yml`) {
    return gh.hasWorkflow ? ok({ id: 1, path: '.github/workflows/release.yml', state: 'active' }) : notFound
  }
  const dispatched = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/release\.yml\/runs\?event=workflow_dispatch&per_page=5$/.exec(api)
  if (dispatched) {
    if (!gh.hasWorkflow) return notFound
    return ok({ total_count: gh.dispatchRuns.length, workflow_runs: gh.dispatchRuns.slice(0, 5).map((r, i) => ({ ...r, event: 'workflow_dispatch', html_url: `https://github.com/${REPO}/actions/runs/${i + 2}` })) })
  }
  const compare = new RegExp(`^repos/${REPO}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`).exec(api)
  if (compare) {
    const [base, head] = [compare[1] as string, compare[2] as string]
    const status =
      base === head
        ? 'identical'
        : base === MERGE_SHA
          ? (gh.ancestry[head] ?? (head === RELEASE_SHA ? 'ahead' : head === OLD_SHA ? 'behind' : 'diverged'))
          : 'diverged'
    return ok({ status })
  }
  const release = new RegExp(`^repos/${REPO}/releases/tags/(.+)$`).exec(api)
  if (release) {
    const tag = decodeURIComponent(release[1] as string)
    return gh.releases.includes(tag) ? ok({ tag_name: tag, draft: false }) : notFound
  }
  const pkg = /^(users|orgs)\/acme\/packages\/container\/widget(\/versions\?per_page=30)?$/.exec(api)
  if (pkg) {
    if (gh.pkg !== pkg[1]) return notFound
    return pkg[2]
      ? ok(gh.versions.map((v, i) => ({ id: i + 1, name: v.digest, metadata: { container: { tags: v.tags } } })))
      : ok({ name: 'widget', package_type: 'container' })
  }
  const commit = new RegExp(`^repos/${REPO}/commits/(.+)$`).exec(api)
  if (commit) {
    const sha = gh.floating[decodeURIComponent(commit[1] as string)]
    return sha ? ok({ sha }) : notFound
  }
  return notFound
}

/** The release cut by the merge: tag v1.2.3 on the release commit, its Release published. */
export function cutRelease(gh: GitHub, tag = 'v1.2.3', sha = RELEASE_SHA) {
  gh.tags = [{ name: tag, sha }, ...gh.tags]
  gh.releases = [...gh.releases, tag]
}

/** The registry pushed the image for `tag`. */
export function pushImage(gh: GitHub, tag = 'v1.2.3') {
  gh.versions = [{ digest: DIGEST, tags: [tag.replace(/^v/, ''), tag] }, ...gh.versions]
}
