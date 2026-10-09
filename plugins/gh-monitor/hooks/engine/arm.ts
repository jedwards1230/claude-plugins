/**
 * Arming: reading what a tool call, a notification, a typed prompt or a
 * command asks to watch. Every parser here is pure and returns ArmRequests;
 * the engine confirms each through gh before anything is shown.
 *
 * Routes (design §3.8):
 *   1  Bash `gh pr create|view|checks|merge|ready|edit|comment|review`, `git push`,
 *      `gitOperation.pr`; Monitor running ci-watch.py
 *   2  task-notification lines `PR #12: MERGED` / `owner/repo#12: …,MERGED`
 *   3  the person typing "merged"
 *   4  Bash `gh workflow run`, `gh run watch`, `gh release view|list`; Monitor running release-watch.py
 *   5  /watch-pr, /watch-release
 */
import type { ArmSource, Repo } from './model'
import {
  commandsOf,
  envRepo,
  ENV_RE,
  ghAt,
  gitOperationPr,
  outputOf,
  prOfUrl,
  prUrlsIn,
  REDIRECT_RE,
  repoOf,
} from './shell'

export type ArmRequest =
  /** A PR known by repo and number. */
  | { kind: 'pr'; source: ArmSource; repo: Repo; pr: number; cwd?: string }
  /**
   * A PR to resolve with `gh pr view [selector] [-R repo]` in `cwd`: a number,
   * a branch, or (no selector) the current branch. `openOnly`: a `git push`
   * only arms an open PR.
   */
  | { kind: 'pr-lookup'; source: ArmSource; selector?: string; repo?: Repo; cwd?: string; openOnly?: boolean }
  /** Every open PR in a repo (ci-watch.py with no PR); no repo = the cwd repo. */
  | { kind: 'pr-list'; source: ArmSource; repo?: Repo; cwd?: string }
  /** `gh workflow run <workflow>`: a dispatched run, if the workflow is the release one. */
  | { kind: 'dispatch'; source: ArmSource; workflow: string; repo?: Repo; cwd?: string }
  /** `gh run watch <id>`: that run, if its workflow is the release one. */
  | { kind: 'run'; source: ArmSource; runId: number; repo?: Repo; cwd?: string }
  /**
   * A repo's release. `discover`: arm only if a release run is active or
   * finished within 10 min (a `gh release view|list` loop).
   */
  | { kind: 'release'; source: ArmSource; repo?: Repo; tag?: string; discover: boolean; cwd?: string }

/** `gh pr` verbs that name a PR and arm it. */
const PR_VERBS = new Set(['create', 'view', 'checks', 'merge', 'ready', 'edit', 'comment', 'review'])
/** `gh pr` flags that take a value. */
const PR_VALUE_FLAGS = new Set([
  '-b', '--body', '-F', '--body-file', '-t', '--title', '--subject', '-A', '--author-email',
  '--match-head-commit', '-R', '--repo', '-B', '--base', '-H', '--head', '-a', '--assignee',
  '-l', '--label', '-m', '--milestone', '-r', '--reviewer', '-p', '--project', '-q', '--jq',
  '-T', '--template', '--json', '-c', '--comment', '--add-label', '--remove-label',
  '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project',
  '--remove-project', '--recover', '-i', '--interval',
])

export type PrCommand = {
  verb: string
  cwd?: string
  repo?: Repo
  /** A number, `#12`, URL or branch; undefined = the current branch. */
  selector?: string
  /** `gh pr merge --auto`: may only enable auto-merge. */
  auto: boolean
}

/** Every `gh pr <verb>` in a Bash command (verbs in PR_VERBS). */
export function parsePrCommands(command: string): PrCommand[] {
  const out: PrCommand[] = []
  for (const { words, cwd } of commandsOf(command)) {
    const at = ghAt(words, 'pr')
    if (at < 0) continue
    const verb = words[at + 2] as string
    if (!PR_VERBS.has(verb)) continue
    const args = words.slice(at + 3)
    if (verb === 'create' && (args.includes('--web') || args.includes('-w'))) continue
    if (verb === 'view' && (args.includes('--web') || args.includes('-w'))) continue
    if (verb === 'merge' && args.includes('--disable-auto')) continue
    const cmd: PrCommand = { verb, auto: false, ...(cwd !== undefined ? { cwd } : {}) }
    const env = envRepo(words, at)
    if (env) cmd.repo = env
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      const redirect = REDIRECT_RE.exec(arg)
      if (redirect) {
        if (redirect[0].length === arg.length) i++
        continue
      }
      if (arg === '--auto') {
        cmd.auto = true
        continue
      }
      if (arg.startsWith('-')) {
        const eq = arg.indexOf('=')
        const name = eq > 0 ? arg.slice(0, eq) : arg
        const inline = eq > 0 ? arg.slice(eq + 1) : undefined
        if (!PR_VALUE_FLAGS.has(name)) continue
        const value = inline ?? args[++i]
        if (name === '-R' || name === '--repo') {
          const repo = repoOf(value)
          if (repo) cmd.repo = repo
        }
        continue
      }
      if (verb === 'create' || cmd.selector !== undefined) continue
      const url = prOfUrl(arg)
      if (url) {
        cmd.repo = url.repo
        cmd.selector = String(url.pr)
      } else {
        cmd.selector = arg.replace(/^#/, '')
      }
    }
    out.push(cmd)
  }
  return out
}

/** A `git push` that pushes a branch, with the branch it names (if any) and its directory. */
export type Push = { cwd?: string; branch?: string }

const PUSH_VALUE_FLAGS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option', '--signed'])
const PUSH_NO_BRANCH = new Set(['--tags', '--delete', '-d', '--mirror', '--prune', '--dry-run', '-n', '--all'])

/** A `git push` of a branch; undefined when the command pushes no branch. */
export function parsePush(command: string): Push | undefined {
  for (const { words, cwd } of commandsOf(command)) {
    const at = words.findIndex(w => w === 'git' || w.endsWith('/git'))
    if (at < 0 || !words.slice(0, at).every(w => ENV_RE.test(w))) continue
    let i = at + 1
    let dir = cwd
    while (i < words.length && (words[i] as string).startsWith('-')) {
      const w = words[i] as string
      if (w === '-C' || w === '-c') {
        if (w === '-C') dir = words[i + 1]
        i += 2
      } else {
        i += 1
      }
    }
    if (words[i] !== 'push') continue
    const positional: string[] = []
    const args = words.slice(i + 1)
    for (let j = 0; j < args.length; j++) {
      const a = args[j] as string
      const redirect = REDIRECT_RE.exec(a)
      if (redirect) {
        if (redirect[0].length === a.length) j++
        continue
      }
      if (PUSH_NO_BRANCH.has(a) || a.startsWith('--delete=')) return undefined
      if (a.startsWith('-')) {
        if (PUSH_VALUE_FLAGS.has(a)) j++
        continue
      }
      positional.push(a)
    }
    const refspec = positional[1]
    if (refspec?.startsWith(':')) return undefined
    const dst = refspec?.replace(/^\+/, '').split(':').pop()?.replace(/^refs\/heads\//, '')
    if (dst?.startsWith('refs/')) return undefined
    const out: Push = {}
    if (dir !== undefined) out.cwd = dir
    if (dst && dst !== 'HEAD') out.branch = dst
    return out
  }
  return undefined
}

/** What a `ci-watch.py` invocation watches, in its own grammar. */
export type MonitorTargets = {
  cwd?: string
  defaultRepo?: Repo
  /** Explicit PRs per repo; key '' is the default repo. An empty list means every open PR. */
  repos: Map<string, number[]>
}

function validRepo(value: string): boolean {
  const parts = value.split('/')
  return parts.length === 2 && parts.every(p => p !== '')
}

/** Where `<script>` runs as the command itself (or under python3), after VAR=value prefixes; -1 if not. */
function scriptAt(words: readonly string[], script: string): number {
  const at = words.findIndex(w => w === script || w.endsWith(`/${script}`))
  if (at < 0) return -1
  const before = words.slice(0, at).filter(w => !ENV_RE.test(w))
  if (before.length > 1 || (before.length === 1 && !/(^|\/)python3?$/.test(before[0] as string))) return -1
  return at
}

/**
 * A Monitor command running `ci-watch.py`, parsed as ci-watch.py does:
 * `<n>`, `-R owner/repo`, `owner/repo#<n>`, `owner/repo`, nothing (every
 * open PR here). Undefined for arguments ci-watch.py would reject.
 */
export function parseCiWatchCommand(command: string | undefined): MonitorTargets | undefined {
  if (!command) return undefined
  for (const { words, cwd } of commandsOf(command)) {
    const at = scriptAt(words, 'ci-watch.py')
    if (at < 0) continue
    const out: MonitorTargets = { repos: new Map(), ...(cwd !== undefined ? { cwd } : {}) }
    const add = (repo: string, pr?: number) => {
      const list = out.repos.get(repo) ?? []
      if (pr !== undefined && !list.includes(pr)) list.push(pr)
      out.repos.set(repo, list)
    }
    const args = words.slice(at + 1)
    for (let i = 0; i < args.length; i++) {
      const t = args[i] as string
      const redirect = REDIRECT_RE.exec(t)
      if (redirect) {
        if (redirect[0].length === t.length) i++
        continue
      }
      if (t === '-R') {
        const repo = repoOf(args[++i])
        if (!repo) return undefined
        out.defaultRepo = repo
        continue
      }
      if (t.includes('#')) {
        const hash = t.lastIndexOf('#')
        const repo = t.slice(0, hash)
        const num = t.slice(hash + 1)
        if (!validRepo(repo) || !/^\d+$/.test(num)) return undefined
        add(repo, Number(num))
      } else if (/^\d+$/.test(t)) {
        add('', Number(t))
      } else if (t.includes('/')) {
        if (!validRepo(t)) return undefined
        add(t)
      } else {
        return undefined
      }
    }
    if (out.repos.size === 0) out.repos.set('', [])
    return out
  }
  return undefined
}

/** ci-watch.py targets as ArmRequests (`''` resolved against `-R` or the cwd repo). */
export function ciWatchRequests(m: MonitorTargets): ArmRequest[] {
  const out: ArmRequest[] = []
  const cwd = m.cwd !== undefined ? { cwd: m.cwd } : {}
  // Explicit PRs for the default repo merge with a bare default-repo entry, so `-R r 12` is not also "all".
  const merged = new Map<string, number[]>()
  for (const [repo, prs] of m.repos) {
    const key = repo === '' ? (m.defaultRepo ?? '') : repo
    const list = merged.get(key)
    merged.set(key, list === undefined ? [...prs] : [...list, ...prs.filter(n => !list.includes(n))])
  }
  for (const [repo, prs] of merged) {
    if (prs.length === 0) {
      out.push({ kind: 'pr-list', source: 'ci-watch', ...(repo ? { repo } : {}), ...cwd })
    } else if (repo) {
      for (const pr of prs) out.push({ kind: 'pr', source: 'ci-watch', repo, pr, ...cwd })
    } else {
      for (const pr of prs) out.push({ kind: 'pr-lookup', source: 'ci-watch', selector: String(pr), ...cwd })
    }
  }
  return out
}

/** A Monitor command running `release-watch.py`: its repo targets (with `--tag`) and `--ghcr` packages. */
export function parseReleaseWatchCommand(command: string | undefined): ArmRequest[] | undefined {
  if (!command) return undefined
  for (const { words, cwd } of commandsOf(command)) {
    const at = scriptAt(words, 'release-watch.py')
    if (at < 0) continue
    type T = { repo: Repo; tag?: string; ghcr: boolean }
    const targets: T[] = []
    const args = words.slice(at + 1)
    for (let i = 0; i < args.length; i++) {
      const t = args[i] as string
      const redirect = REDIRECT_RE.exec(t)
      if (redirect) {
        if (redirect[0].length === t.length) i++
        continue
      }
      if (t === '--ghcr') {
        const spec = args[++i] ?? ''
        const slash = spec.indexOf('/')
        if (slash <= 0 || slash === spec.length - 1) return undefined
        const pkg = spec.slice(slash + 1)
        // `owner/pkg` maps to repo owner/pkg; a nested package (charts/x) names no repo.
        const repo = pkg.includes('/') ? undefined : repoOf(spec)
        if (repo) targets.push({ repo, ghcr: true })
        else targets.push({ repo: '', ghcr: true })
        continue
      }
      if (t === '--tag') {
        const tag = args[++i]
        const last = targets.at(-1)
        if (tag === undefined || !last) return undefined
        last.tag = tag
        continue
      }
      if (t.startsWith('-')) return undefined
      if (!validRepo(t)) return undefined
      targets.push({ repo: t, ghcr: false })
    }
    const out: ArmRequest[] = []
    for (const t of targets) {
      if (!t.repo) continue
      // A repo named both as a repo and as a package is one release.
      const dup = out.find(o => o.kind === 'release' && o.repo?.toLowerCase() === t.repo.toLowerCase())
      if (dup && dup.kind === 'release') {
        if (t.tag && !dup.tag && !t.ghcr) dup.tag = t.tag
        continue
      }
      out.push({
        kind: 'release',
        source: 'release-watch',
        repo: t.repo,
        // A package's --tag may be `1.2.3`; only a repo's --tag is the release tag.
        ...(t.tag && !t.ghcr ? { tag: t.tag } : {}),
        discover: false,
        ...(cwd !== undefined ? { cwd } : {}),
      })
    }
    return out
  }
  return undefined
}

/** `-R`/`--repo` value in a gh argument list, or GH_REPO. */
function repoFlag(args: readonly string[]): Repo | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '-R' || a === '--repo') return repoOf(args[i + 1])
    if (a.startsWith('--repo=')) return repoOf(a.slice(7))
  }
  return undefined
}

/** First positional argument, skipping flags (and the value of the flags in `valueFlags`). */
function firstPositional(args: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const redirect = REDIRECT_RE.exec(a)
    if (redirect) {
      if (redirect[0].length === a.length) i++
      continue
    }
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(a)) i++
      continue
    }
    return a
  }
  return undefined
}

const WORKFLOW_RUN_FLAGS = new Set(['-R', '--repo', '-r', '--ref', '-f', '--raw-field', '-F', '--field', '--json'])
const RUN_WATCH_FLAGS = new Set(['-R', '--repo', '-i', '--interval'])

/** Route 4 Bash commands: `gh workflow run`, `gh run watch`, `gh release view|list`. */
export function parseReleaseCommands(command: string): ArmRequest[] {
  const out: ArmRequest[] = []
  for (const { words, cwd } of commandsOf(command)) {
    const c = cwd !== undefined ? { cwd } : {}
    let at = ghAt(words, 'workflow', 'run')
    if (at >= 0) {
      const args = words.slice(at + 3)
      const workflow = firstPositional(args, WORKFLOW_RUN_FLAGS)
      const repo = repoFlag(args) ?? envRepo(words, at)
      if (workflow) out.push({ kind: 'dispatch', source: 'dispatch', workflow, ...(repo ? { repo } : {}), ...c })
      continue
    }
    at = ghAt(words, 'run', 'watch')
    if (at >= 0) {
      const args = words.slice(at + 3)
      const id = firstPositional(args, RUN_WATCH_FLAGS)
      const repo = repoFlag(args) ?? envRepo(words, at)
      if (id && /^\d+$/.test(id)) out.push({ kind: 'run', source: 'run-watch', runId: Number(id), ...(repo ? { repo } : {}), ...c })
      continue
    }
    for (const verb of ['view', 'list']) {
      at = ghAt(words, 'release', verb)
      if (at < 0) continue
      const args = words.slice(at + 3)
      if (args.includes('--web') || args.includes('-w')) break
      const repo = repoFlag(args) ?? envRepo(words, at)
      out.push({ kind: 'release', source: 'release-cmd', ...(repo ? { repo } : {}), discover: true, ...c })
      break
    }
  }
  return out
}

/** Route 1 from a finished Bash call: gitOperation, `gh pr …`, `git push`, PR URLs printed by those. */
export function bashPrRequests(command: string, result: unknown): ArmRequest[] {
  const out: ArmRequest[] = []
  const prCmds = parsePrCommands(command)
  const op = gitOperationPr(result)
  const firstCwd = prCmds[0]?.cwd
  if (op) {
    const url = prOfUrl(op.url)
    if (url) out.push({ kind: 'pr', source: op.action === 'created' ? 'pr-create' : 'pr-cmd', repo: url.repo, pr: url.pr })
    else {
      const repo = prCmds.find(c => c.repo)?.repo
      out.push({
        kind: 'pr-lookup',
        source: op.action === 'created' ? 'pr-create' : 'pr-cmd',
        selector: String(op.number),
        ...(repo ? { repo } : {}),
        ...(firstCwd !== undefined ? { cwd: firstCwd } : {}),
      })
    }
  }
  const output = prCmds.length > 0 ? outputOf(result) : ''
  const urls = prUrlsIn(output).slice(0, 5)
  for (const cmd of prCmds) {
    const source: ArmSource = cmd.verb === 'create' ? 'pr-create' : 'pr-cmd'
    const cwd = cmd.cwd !== undefined ? { cwd: cmd.cwd } : {}
    if (cmd.verb === 'create') {
      const last = urls.at(-1)
      if (last) out.push({ kind: 'pr', source, ...last, ...cwd })
      continue
    }
    if (cmd.selector !== undefined && /^\d+$/.test(cmd.selector) && cmd.repo) {
      out.push({ kind: 'pr', source, repo: cmd.repo, pr: Number(cmd.selector), ...cwd })
    } else {
      out.push({
        kind: 'pr-lookup',
        source,
        ...(cmd.selector !== undefined ? { selector: cmd.selector } : {}),
        ...(cmd.repo ? { repo: cmd.repo } : {}),
        ...cwd,
      })
    }
  }
  if (prCmds.length > 0) for (const u of urls) out.push({ kind: 'pr', source: 'url', ...u, ...(firstCwd !== undefined ? { cwd: firstCwd } : {}) })
  for (const m of apiMerges(command)) out.push({ kind: 'pr', source: 'pr-cmd', ...m })
  const push = parsePush(command)
  if (push) {
    out.push({
      kind: 'pr-lookup',
      source: 'push',
      ...(push.branch ? { selector: push.branch } : {}),
      ...(push.cwd !== undefined ? { cwd: push.cwd } : {}),
      openOnly: true,
    })
  }
  return out
}

/** `gh api repos/o/r/pulls/N/merge -X PUT` (or `--method PUT`): a merge through the REST API. */
export function apiMerges(command: string): { repo: Repo; pr: number; cwd?: string }[] {
  const out: { repo: Repo; pr: number; cwd?: string }[] = []
  for (const { words, cwd } of commandsOf(command)) {
    const at = ghAt(words, 'api')
    if (at < 0) continue
    const args = words.slice(at + 2)
    const path = args.map(a => /^\/?repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls\/(\d+)\/merge$/.exec(a)).find(Boolean)
    const put = args.some((a, i) => ((a === '-X' || a === '--method') && /^put$/i.test(args[i + 1] ?? '')) || /^--method=put$/i.test(a) || /^-XPUT$/i.test(a))
    if (path && put) out.push({ repo: path[1] as string, pr: Number(path[2]), ...(cwd !== undefined ? { cwd } : {}) })
  }
  return out
}

/** A `MERGED` line in a task notification: `PR #12: MERGED …` or `owner/repo#12: …,MERGED …`. */
export type MergedLine = { repo?: Repo; pr: number }

const MERGED_LINE_G = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|PR #)(\d+): (?:[^\n]*?,)?MERGED\b/g

export function mergedLinesIn(text: string): MergedLine[] {
  const out: MergedLine[] = []
  for (const m of text.matchAll(MERGED_LINE_G)) {
    const repo = repoOf(m[1])
    const pr = Number(m[2])
    if (!out.some(o => o.pr === pr && o.repo?.toLowerCase() === repo?.toLowerCase())) {
      out.push(repo ? { repo, pr } : { pr })
    }
  }
  return out
}

/** The person saying they merged: `merged`, `I merged #12`, `just merged https://…/pull/12`. */
export const TYPED_MERGED_RE = /^\s*(?:i\s+)?(?:just\s+)?merged\b(?!\s*\?)/i

/** What a typed "merged" names: an explicit `owner/repo#N`, PR URL, or `#N`. */
export function typedMerged(text: string): { matched: boolean; repo?: Repo; pr?: number } {
  if (!TYPED_MERGED_RE.test(text)) return { matched: false }
  const url = prUrlsIn(text)[0]
  if (url) return { matched: true, ...url }
  const qualified = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/.exec(text)
  if (qualified) return { matched: true, repo: qualified[1] as string, pr: Number(qualified[2]) }
  const bare = /(?:^|\s)#(\d+)\b/.exec(text) ?? /^\s*(?:i\s+)?(?:just\s+)?merged\s+(\d+)\b/i.exec(text)
  if (bare) return { matched: true, pr: Number(bare[1]) }
  return { matched: true }
}

/** `/watch-pr` arguments: `N`, `owner/repo#N`, a PR URL, or `owner/repo N`, any number of them. */
export function parseWatchPrArgs(args: string): { targets: { repo?: Repo; pr: number }[]; bad: string[] } {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const targets: { repo?: Repo; pr: number }[] = []
  const bad: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    const url = prOfUrl(w)
    if (url) {
      targets.push(url)
      continue
    }
    const q = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(w)
    if (q) {
      targets.push({ repo: q[1] as string, pr: Number(q[2]) })
      continue
    }
    const n = /^#?(\d+)$/.exec(w)
    if (n) {
      targets.push({ pr: Number(n[1]) })
      continue
    }
    const repo = validRepo(w) ? repoOf(w) : undefined
    const next = words[i + 1]
    if (repo && next !== undefined && /^#?\d+$/.test(next)) {
      targets.push({ repo, pr: Number(next.replace('#', '')) })
      i++
      continue
    }
    bad.push(w)
  }
  return { targets, bad }
}

/** `/watch-release <owner/repo> [--pr N | --tag vX]`. */
export function parseWatchReleaseArgs(
  args: string,
): { repo: Repo; pr?: number; tag?: string } | undefined {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  let repo: Repo | undefined
  let pr: number | undefined
  let tag: string | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (w === '--pr') {
      const v = words[++i]?.replace(/^#/, '')
      if (!v || !/^\d+$/.test(v)) return undefined
      pr = Number(v)
    } else if (w === '--tag') {
      const v = words[++i]
      if (!v || v.startsWith('-')) return undefined
      tag = v
    } else if (!repo && validRepo(w) && repoOf(w)) {
      repo = repoOf(w)
    } else {
      return undefined
    }
  }
  if (!repo || (pr !== undefined && tag !== undefined)) return undefined
  return { repo, ...(pr !== undefined ? { pr } : {}), ...(tag !== undefined ? { tag } : {}) }
}
