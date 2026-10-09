/**
 * Release Ticker — pure logic: parsing the merge command and the plugin's
 * options, and the stage machine that walks a merge through its release
 * (workflow -> tag -> GitHub release -> image). No `$`, no I/O: every
 * function here takes plain data, so the tests import it directly.
 */

/** Where a `gh pr merge` points: the repo and PR it names, if any. */
export type MergeCommand = {
  /** `owner/repo` from `--repo`/`-R`, a PR URL, or `GH_REPO=`. */
  repo?: string
  /** The PR selector: a number, or a branch name. */
  pr?: string
  /** A directory the command `cd`s into before running gh. */
  cwd?: string
  /** `--auto`: gh may only enable auto-merge, not merge. */
  auto: boolean
}

/** A floating tag to keep in step with a repo's releases. */
export type FloatingTag = { repo: string; tag: string }

export type Config = {
  releaseWorkflow: string
  registry: string
  floatingTags: FloatingTag[]
  timeoutMs: number
}

export const DEFAULTS = {
  releaseWorkflow: 'release.yml',
  registry: 'ghcr.io',
  timeoutMin: 20,
} as const

/** How often an armed watch polls. */
export const POLL_MS = 30_000
/** How long a merge may go without a release run before the watch gives up quietly. */
export const NO_RUN_GRACE_MS = 3 * 60_000
/**
 * How long after a successful run the tag may take to appear. A release
 * workflow tags inside its own run, so a short wait is enough; past it the
 * run cut nothing (a chore merge that needs no version bump).
 */
export const TAG_GRACE_MS = 90_000
/** How long after the tag its GitHub release may take to appear. */
export const RELEASE_GRACE_MS = 2 * 60_000
/**
 * The longest status text: Claude Code prefixes the line with ` ⚠ git-tooling: `
 * (16 characters) and the whole line must fit in 82.
 */
export const STATUS_MAX = 66
/** How recently the PR must have merged for a `gh pr merge` to arm (an old, already-merged PR does not). */
export const RECENT_MERGE_MS = 5 * 60_000
/** Clock skew tolerated between this machine and GitHub's `mergedAt`. */
const CLOCK_SKEW_MS = 60_000

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PR_URL_RE = /^https?:\/\/[^/]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/

/** `gh pr merge` flags that take a value (the value is not the PR selector). */
const VALUE_FLAGS = new Set([
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-t',
  '--subject',
  '-A',
  '--author-email',
  '--match-head-commit',
  '-R',
  '--repo',
])

/**
 * Normalizes a repo argument: `owner/repo`, or `HOST/owner/repo` as `-R`
 * also takes. Anything else is undefined.
 */
export function repoOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parts = value.replace(/\.git$/, '').split('/')
  const tail = parts.slice(-2).join('/')
  return parts.length >= 2 && REPO_RE.test(tail) ? tail : undefined
}

/** A redirection operator at the start of a word: `>`, `>>`, `2>`, `2>&1`, `&>`, `<`. */
const REDIRECT_RE = /^(?:\d+|&)?(?:>>|>&|<&|>|<)/

/**
 * Splits a shell command into simple commands (on `&&`, `||`, `;`, `|`, `&`
 * and newlines), each a list of words with quotes and backslashes resolved.
 * The `&` of a redirection (`2>&1`, `&>file`) stays in its word.
 * Good enough for the commands an agent writes; not a full shell parser.
 */
export function segmentsOf(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      const nextChar = command[++i] as string
      if (nextChar !== '\n') {
        word += nextChar
        inWord = true
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '&' && (/[<>]$/.test(word) || command[i + 1] === '>')) {
      // part of a redirection (`2>&1`, `>&2`, `&>file`), not a separator
      word += c
      inWord = true
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endSegment()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return segments
}

/**
 * Reads a Bash command for a `gh pr merge` call: the repo and PR it names,
 * a leading `cd`, and `--auto`. Undefined when the command runs no
 * `gh pr merge` (or runs `gh pr merge --disable-auto`, which merges nothing).
 */
export function parseMergeCommand(command: string): MergeCommand | undefined {
  let cwd: string | undefined
  for (const words of segmentsOf(command)) {
    if (words[0] === 'cd' && words.length === 2) {
      cwd = words[1]
      continue
    }
    const at = words.findIndex(
      (w, i) =>
        (w === 'gh' || w.endsWith('/gh')) && words[i + 1] === 'pr' && words[i + 2] === 'merge',
    )
    // gh must be the command itself (after any VAR=value prefixes), not an argument (`echo gh pr merge`).
    if (at < 0 || !words.slice(0, at).every(w => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) continue

    const merge: MergeCommand = { auto: false }
    if (cwd !== undefined) merge.cwd = cwd
    for (const w of words.slice(0, at)) {
      const env = /^GH_REPO=(.+)$/.exec(w)
      const repo = repoOf(env?.[1])
      if (repo) merge.repo = repo
    }

    const args = words.slice(at + 3)
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      const redirect = REDIRECT_RE.exec(arg)
      if (redirect) {
        // `> log` names its target in the next word; `>log` and `2>&1` carry it.
        if (redirect[0].length === arg.length) i++
        continue
      }
      if (arg === '--disable-auto') return undefined
      if (arg === '--auto') {
        merge.auto = true
        continue
      }
      if (arg.startsWith('-')) {
        const eq = arg.indexOf('=')
        const name = eq > 0 ? arg.slice(0, eq) : arg
        const inline = eq > 0 ? arg.slice(eq + 1) : undefined
        if (!VALUE_FLAGS.has(name)) continue
        const value = inline ?? args[++i]
        if (name === '-R' || name === '--repo') {
          const repo = repoOf(value)
          if (repo) merge.repo = repo
        }
        continue
      }
      if (merge.pr !== undefined) continue
      const url = PR_URL_RE.exec(arg)
      if (url) {
        merge.repo = url[1]
        merge.pr = url[2]
      } else {
        merge.pr = arg.replace(/^#/, '')
      }
    }
    return merge
  }
  return undefined
}

/**
 * Parses `floatingTagRepos` entries, each `owner/repo:tag`. Takes the list
 * the option holds, or one string of comma/whitespace-separated entries;
 * malformed entries are dropped.
 */
export function parseFloatingTagRepos(value: unknown): FloatingTag[] {
  // `claude plugin configure --values-stdin` saves a list option as one string;
  // accept a JSON array written into it as well.
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      return parseFloatingTagRepos(JSON.parse(value))
    } catch {
      // not JSON: fall through to the comma/whitespace split
    }
  }
  const entries: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : []
  const out: FloatingTag[] = []
  for (const entry of entries.flatMap(e => e.split(/[\s,]+/))) {
    const colon = entry.lastIndexOf(':')
    if (colon <= 0) continue
    const repo = repoOf(entry.slice(0, colon).trim())
    const tag = entry.slice(colon + 1).trim()
    if (repo && /^[^\s~^:?*[\\]+$/.test(tag)) out.push({ repo, tag })
  }
  return out
}

/** The plugin's options, defaults filled in and junk ignored. */
export function configOf(options: Readonly<Record<string, unknown>> | undefined): Config {
  const o = options ?? {}
  const workflow =
    typeof o.releaseWorkflow === 'string' && o.releaseWorkflow.trim() !== ''
      ? o.releaseWorkflow.trim().replace(/^\.github\/workflows\//, '')
      : DEFAULTS.releaseWorkflow
  const registry =
    typeof o.registry === 'string' && o.registry.trim() !== ''
      ? o.registry.trim().replace(/\/+$/, '')
      : DEFAULTS.registry
  const minutes = Number(o.timeoutMin)
  const timeoutMin = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULTS.timeoutMin
  return {
    releaseWorkflow: workflow,
    registry,
    floatingTags: parseFloatingTagRepos(o.floatingTagRepos),
    timeoutMs: timeoutMin * 60_000,
  }
}

/** The floating tag configured for a repo, if any (repo names compare case-insensitively). */
export function floatingTagFor(config: Config, repo: string): string | undefined {
  const lower = repo.toLowerCase()
  return config.floatingTags.find(f => f.repo.toLowerCase() === lower)?.tag
}

// ── the stage machine ────────────────────────────────────────────────────

export type Stage = 'run' | 'tag' | 'release' | 'registry'

/** A GHCR-style package the repo publishes, readable through the GitHub Packages API. */
export type Package = { scope: 'users' | 'orgs'; owner: string; name: string }

export type Watch = {
  repo: string
  pr: number
  mergeSha: string
  /** When the PR merged (ms since the epoch, from GitHub's `mergedAt`). */
  mergedAt?: number
  armedAt: number
  deadline: number
  stage: Stage
  /** The release run's status (`queued`, `in_progress`, ...) once one exists. */
  runStatus?: string
  /** When the release run started (GitHub's `run_started_at`, else `created_at`). */
  runStartedAt?: number
  /** When the run finished successfully. */
  runDoneAt?: number
  /** Tag names that existed when the watch armed. */
  baselineTags: readonly string[]
  /** The release tag this merge produced, and the commit it points at. */
  tag?: string
  tagSha?: string
  /** When the tag was first seen. */
  tagSeenAt?: number
  pkg?: Package
  /** The floating tag configured for this repo. */
  floatingTag?: string
}

export type Terminal =
  | { kind: 'published'; tag: string; digest?: string; noDigest?: true }
  | { kind: 'tagged'; tag: string }
  | { kind: 'failed'; conclusion: string; url?: string }
  | { kind: 'no-release' }
  | { kind: 'no-run' }
  | { kind: 'timeout' }

export type Step = { watch: Watch; done?: undefined } | { watch: Watch; done: Terminal }

/** The newest run of the release workflow for the merge commit. */
export type RunObs = { status: string; conclusion: string | null; url?: string; startedAt?: number }
/**
 * A tag and its commit. `related`: whether the commit is the merge commit or
 * descends from it (undefined when that could not be checked).
 */
export type TagObs = { name: string; sha: string; related?: boolean }
export type ReleaseObs = { draft: boolean }
export type VersionObs = { digest: string; tags: readonly string[] }

const GOOD = new Set(['success'])
const QUIET = new Set(['skipped', 'neutral'])

/**
 * The run stage. `run` is the newest release run for the merge commit;
 * null when none exists yet, undefined when the query failed (no change).
 * A repo with a floating tag keeps waiting for a dispatched run until the
 * timeout; any other repo gives up quietly after NO_RUN_GRACE_MS.
 */
export function stepRun(watch: Watch, run: RunObs | null | undefined, now: number): Step {
  if (run === undefined) return { watch }
  if (run === null) {
    const isStale = !watch.floatingTag && now - watch.armedAt >= NO_RUN_GRACE_MS
    return isStale ? { watch, done: { kind: 'no-run' } } : { watch }
  }
  if (run.status !== 'completed') {
    return {
      watch: { ...watch, runStatus: run.status, ...(run.startedAt !== undefined ? { runStartedAt: run.startedAt } : {}) },
    }
  }
  const conclusion = run.conclusion ?? 'unknown'
  if (GOOD.has(conclusion)) {
    return { watch: { ...watch, runStatus: 'completed', stage: 'tag', runDoneAt: now } }
  }
  if (QUIET.has(conclusion)) return { watch, done: { kind: 'no-release' } }
  return { watch, done: { kind: 'failed', conclusion, ...(run.url ? { url: run.url } : {}) } }
}

/**
 * The tag stage: a tag that did not exist at arm time, on the merge commit
 * or on a commit that descends from it (a release commit). A new tag off the
 * merge's history is never taken, and joins the baseline so it is not
 * checked again. None TAG_GRACE_MS after the run succeeded -> no release.
 */
export function stepTag(watch: Watch, tags: readonly TagObs[] | undefined, now: number): Step {
  if (tags === undefined) return { watch }
  const baseline = new Set(watch.baselineTags)
  const fresh = tags.filter(t => !baseline.has(t.name) && t.name !== watch.floatingTag)
  const found = fresh.find(t => t.sha === watch.mergeSha) ?? fresh.find(t => t.related === true)
  if (found) {
    return {
      watch: { ...watch, stage: 'release', tag: found.name, tagSha: found.sha, tagSeenAt: now },
    }
  }
  const unrelated = fresh.filter(t => t.related === false).map(t => t.name)
  const next = unrelated.length > 0 ? { ...watch, baselineTags: [...watch.baselineTags, ...unrelated] } : watch
  const since = watch.runDoneAt ?? now
  return now - since >= TAG_GRACE_MS ? { watch: next, done: { kind: 'no-release' } } : { watch: next }
}

/**
 * The release stage: the GitHub Release for the new tag (null: none yet,
 * undefined: query failed). A tag that never gets a Release ends as
 * `tagged` after RELEASE_GRACE_MS.
 */
export function stepRelease(watch: Watch, release: ReleaseObs | null | undefined, now: number): Step {
  const tag = watch.tag as string
  if (release && !release.draft) {
    return watch.pkg
      ? { watch: { ...watch, stage: 'registry' } }
      : { watch, done: { kind: 'published', tag } }
  }
  if (release === undefined) return { watch }
  const since = watch.tagSeenAt ?? now
  return now - since >= RELEASE_GRACE_MS ? { watch, done: { kind: 'tagged', tag } } : { watch }
}

/** The tags a registry version for release tag `tag` may carry: `v1.2.3` and `1.2.3`. */
export function registryTagsFor(tag: string): string[] {
  return /^v\d/.test(tag) ? [tag, tag.slice(1)] : [tag]
}

/**
 * The registry stage: a package version carrying the release tag. A failed
 * query skips the stage (published, no digest) rather than erroring.
 */
export function stepRegistry(watch: Watch, versions: readonly VersionObs[] | undefined): Step {
  const tag = watch.tag as string
  if (versions === undefined) return { watch, done: { kind: 'published', tag } }
  const wanted = registryTagsFor(tag)
  const found = versions.find(v => v.tags.some(t => wanted.includes(t)))
  return found ? { watch, done: { kind: 'published', tag, digest: found.digest } } : { watch }
}

/**
 * The terminal for a watch that hit its deadline: one already waiting on the
 * registry has its Release out, so it ends as published with no digest seen.
 */
export function timeoutOf(watch: Watch): Terminal {
  return watch.stage === 'registry' && watch.tag
    ? { kind: 'published', tag: watch.tag, noDigest: true }
    : { kind: 'timeout' }
}

/** Whether a PR's `mergedAt` is recent enough that this merge command did it. */
export function isRecentMerge(mergedAt: unknown, now: number): boolean {
  const at = typeof mergedAt === 'string' ? Date.parse(mergedAt) : Number.NaN
  if (!Number.isFinite(at)) return false
  return now - at <= RECENT_MERGE_MS && at - now <= CLOCK_SKEW_MS
}

/** Whether the floating tag is checked at this terminal (not on a failed run, where nothing moved). */
export function checksFloatingTag(watch: Watch, done: Terminal): boolean {
  return watch.floatingTag !== undefined && done.kind !== 'failed' && done.kind !== 'no-run'
}

/**
 * Whether the floating tag was left behind: it should point at the new
 * release tag's commit, or at the merge commit when no release happened.
 * An unknown floating-tag commit never nags.
 */
export function isFloatingTagStale(watch: Watch, floatingSha: string | undefined): boolean {
  if (!floatingSha) return false
  return floatingSha !== (watch.tagSha ?? watch.mergeSha)
}

// ── text ────────────────────────────────────────────────────────────────

export function shortDigest(digest: string): string {
  const m = /^(sha256:)?([0-9a-f]+)$/i.exec(digest)
  return m ? `${m[1] ?? ''}${(m[2] as string).slice(0, 12)}` : digest
}

/** The user-facing name of each stage, used alike in the status line, toasts and README. */
export const STAGE_NAMES: Record<Stage, string> = {
  run: 'workflow',
  tag: 'tag',
  release: 'GitHub release',
  registry: 'image',
}

const STAGE_ORDER: readonly Stage[] = ['run', 'tag', 'release', 'registry']

/** The stages this watch walks: the image stage only when the repo publishes a package (decided at arm time). */
export function stagesOf(watch: Watch): Stage[] {
  return watch.pkg ? [...STAGE_ORDER] : STAGE_ORDER.slice(0, 3)
}

/** `2/4`: the current stage's position among the stages that apply. */
export function stepCountOf(watch: Watch): string {
  const stages = stagesOf(watch)
  return `${stages.indexOf(watch.stage) + 1}/${stages.length}`
}

/** `40s`, `1m 40s`, `1h 5m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

/** Cuts `s` to `n` characters, ending in `…` when cut. */
export function elide(s: string, n: number): string {
  if (s.length <= n) return s
  return n <= 1 ? '…' : `${s.slice(0, n - 1)}…`
}

/** The parts of one status segment that may be shortened to fit. */
type Parts = { name: string; ver: string; wf: string; elapsed: string; compact: boolean }

function renderSegment(watch: Watch, p: Parts): string {
  const phrase = (() => {
    switch (watch.stage) {
      case 'run':
        if (watch.runStatus === 'in_progress') return `workflow running${p.elapsed ? ` ${p.elapsed}` : ''}`
        if (watch.runStatus) return `workflow ${watch.runStatus.replace(/_/g, ' ')}`
        if (watch.floatingTag) return `dispatch ${p.wf} to move ${watch.floatingTag}`
        return p.compact ? 'waiting for workflow' : 'waiting for workflow to start'
      case 'tag':
        return 'workflow done, waiting for tag'
      case 'release':
        return `tagged ${p.ver}, waiting for ${p.compact ? 'release' : 'GitHub release'}`
      case 'registry':
        return `${p.ver} released, waiting for image`
    }
  })()
  return `${p.name} #${watch.pr} · ${stepCountOf(watch)} · ${phrase}`
}

/**
 * One watch's part of the status line, at most `max` characters: the repo
 * name (owner dropped), the step count, and what it is waiting for. Too
 * long, it elides the repo name, drops the elapsed time, elides the
 * version, shortens the phrase, then elides further, in that order.
 */
export function statusTextOf(watch: Watch, config: Config, now: number, max = STATUS_MAX): string {
  const p: Parts = {
    name: watch.repo.split('/')[1] ?? watch.repo,
    ver: watch.tag ?? '',
    wf: config.releaseWorkflow,
    elapsed: formatElapsed(now - (watch.runStartedAt ?? watch.armedAt)),
    compact: false,
  }
  const shrink = (key: 'name' | 'ver' | 'wf', min: number) => {
    const over = renderSegment(watch, p).length - max
    if (over > 0) p[key] = elide(p[key], Math.max(min, p[key].length - over))
  }
  const fits = () => renderSegment(watch, p).length <= max
  shrink('name', 14)
  if (!fits()) p.elapsed = ''
  shrink('ver', 10)
  if (!fits()) p.compact = true
  shrink('name', 6)
  shrink('wf', 8)
  shrink('ver', 5)
  return elide(renderSegment(watch, p), max)
}

/**
 * The status line for every armed watch, or undefined when none is armed.
 * Several watches share the line when they fit; otherwise the newest is
 * shown with `+N more`.
 */
export function statusLineOf(watches: readonly Watch[], config: Config, now: number): string | undefined {
  if (watches.length === 0) return undefined
  const newest = [...watches].sort((a, b) => b.armedAt - a.armedAt)
  const all = newest.map(w => statusTextOf(w, config, now, Number.POSITIVE_INFINITY)).join(' | ')
  if (all.length <= STATUS_MAX) return all
  if (newest.length === 1) return statusTextOf(newest[0] as Watch, config, now)
  const more = ` | +${newest.length - 1} more`
  return statusTextOf(newest[0] as Watch, config, now, STATUS_MAX - more.length) + more
}

/** `owner/repo #12`, how a toast names the merge. */
function labelOf(watch: Watch): string {
  return `${watch.repo} #${watch.pr}`
}

/** The toast a terminal shows; undefined for the quiet ones. */
export function toastTextOf(watch: Watch, done: Terminal, config: Config): string | undefined {
  const pr = labelOf(watch)
  const minutes = Math.round(config.timeoutMs / 60_000)
  switch (done.kind) {
    case 'published':
      if (done.digest) return `${pr}: ${done.tag} published (GitHub release + ${config.registry} image ${shortDigest(done.digest)})`
      if (done.noDigest) return `${pr}: ${done.tag} published (GitHub release; no ${config.registry} image after ${minutes} min)`
      return watch.pkg
        ? `${pr}: ${done.tag} published (GitHub release; ${config.registry} image not checked)`
        : `${pr}: ${done.tag} published (GitHub release)`
    case 'tagged':
      return `${pr}: tagged ${done.tag}, but no GitHub release appeared`
    case 'failed':
      return `${pr}: ${config.releaseWorkflow} failed (${done.conclusion})`
    case 'no-release':
      return `${pr}: ${config.releaseWorkflow} ran but cut no new version (nothing to release)`
    case 'timeout':
      return `${pr}: still waiting for the ${STAGE_NAMES[watch.stage]} after ${minutes} min — gave up`
    case 'no-run':
      return undefined
  }
}

export function nagTextOf(watch: Watch, config: Config): string {
  return `${labelOf(watch)}: floating tag ${watch.floatingTag} not moved — dispatch ${config.releaseWorkflow} to move it`
}

/** Whether a `tool.call` result means the command actually ran to completion. */
export function isCompleted(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const r = result as { deny?: unknown; isError?: unknown; result?: unknown }
  if (r.deny !== undefined || r.isError === true) return false
  const inner = r.result
  if (inner && typeof inner === 'object') {
    const o = inner as { interrupted?: unknown; backgroundTaskId?: unknown }
    if (o.interrupted === true || o.backgroundTaskId) return false
  }
  return true
}
