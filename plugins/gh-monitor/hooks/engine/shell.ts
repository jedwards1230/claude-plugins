/**
 * Reading shell commands and tool results: word splitting good enough for
 * the commands an agent writes, repo-name normalizing, PR URLs. No `$`.
 */
import type { Repo } from './model'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** A `VAR=value` prefix word. */
export const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
/** A redirection operator at the start of a word: `>`, `>>`, `2>`, `2>&1`, `&>`, `<`. */
export const REDIRECT_RE = /^(?:\d+|&)?(?:>>|>&|<&|>|<)/
/** A PR URL; group 1 the repo, group 2 the number. */
export const PR_URL_RE = /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/
const PR_URL_G = /https?:\/\/[^\s/]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g

/**
 * Normalizes a repo argument: `owner/repo`, `HOST/owner/repo` or a repo URL.
 * Anything else is undefined.
 */
export function repoOf(value: string | undefined): Repo | undefined {
  if (!value) return undefined
  const parts = value.trim().replace(/\.git$/, '').replace(/\/+$/, '').split('/')
  const tail = parts.slice(-2).join('/')
  return parts.length >= 2 && REPO_RE.test(tail) ? tail : undefined
}

/** Same repo, ignoring case. */
export function sameRepo(a: Repo | undefined, b: Repo | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

/**
 * Splits a shell command into simple commands (on `&&`, `||`, `;`, `|`, `&`
 * and newlines), each a list of words with quotes and backslashes resolved.
 * The `&` of a redirection (`2>&1`, `&>file`) stays in its word.
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

/** One simple command with the directory a preceding `cd` moved to. */
export type Segment = { words: string[]; cwd?: string }

/** segmentsOf with each segment's `cd` directory carried forward. */
export function commandsOf(command: string): Segment[] {
  let cwd: string | undefined
  const out: Segment[] = []
  for (const words of segmentsOf(command)) {
    if (words[0] === 'cd' && words.length === 2) {
      cwd = words[1]
      continue
    }
    out.push(cwd !== undefined ? { words, cwd } : { words })
  }
  return out
}

/**
 * Where `gh <sub> <verb>` starts when it is the command itself (after any
 * `VAR=value` prefixes, never an argument as in `echo gh pr merge`); -1 if not.
 */
export function ghAt(words: readonly string[], sub: string, verb?: string): number {
  const at = words.findIndex(
    (w, i) =>
      (w === 'gh' || w.endsWith('/gh')) && words[i + 1] === sub && (verb === undefined || words[i + 2] === verb),
  )
  return at >= 0 && words.slice(0, at).every(w => ENV_RE.test(w)) ? at : -1
}

/** `GH_REPO=owner/repo` among the prefix words. */
export function envRepo(words: readonly string[], until: number): Repo | undefined {
  for (const w of words.slice(0, until)) {
    const m = /^GH_REPO=(.+)$/.exec(w)
    const repo = repoOf(m?.[1])
    if (repo) return repo
  }
  return undefined
}

/** A PR URL's repo and number. */
export function prOfUrl(text: string | undefined): { repo: Repo; pr: number } | undefined {
  const m = text ? PR_URL_RE.exec(text.trim()) : null
  return m ? { repo: m[1] as string, pr: Number(m[2]) } : undefined
}

/** Every PR URL in some text, in order, deduped. */
export function prUrlsIn(text: string): { repo: Repo; pr: number }[] {
  const out: { repo: Repo; pr: number }[] = []
  for (const m of text.matchAll(PR_URL_G)) {
    const t = { repo: m[1] as string, pr: Number(m[2]) }
    if (!out.some(o => sameRepo(o.repo, t.repo) && o.pr === t.pr)) out.push(t)
  }
  return out
}

/** The repo a PR URL belongs to. */
export function repoFromUrl(url: unknown): Repo | undefined {
  const m = typeof url === 'string' ? /\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url) : null
  return repoOf(m?.[1])
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Whether a `tool.call` result means the command ran to completion (not denied, errored, interrupted or backgrounded). */
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

/** The stdout (and stderr) of a completed Bash result. */
export function outputOf(result: unknown): string {
  const inner = recordOf(result).result
  if (typeof inner === 'string') return inner
  const o = recordOf(inner)
  return [o.stdout, o.stderr].filter((s): s is string => typeof s === 'string').join('\n')
}

/** The PR a Bash result's `gitOperation` names, if any. */
export function gitOperationPr(result: unknown): { number: number; url?: string; action?: string } | undefined {
  const pr = recordOf(recordOf(recordOf(recordOf(result).result).gitOperation).pr)
  if (typeof pr.number !== 'number') return undefined
  return {
    number: pr.number,
    ...(typeof pr.url === 'string' ? { url: pr.url } : {}),
    ...(typeof pr.action === 'string' ? { action: pr.action } : {}),
  }
}

/** A Monitor result's task id. */
export function taskIdOf(result: unknown): string | undefined {
  const id = recordOf(recordOf(result).result).taskId
  return typeof id === 'string' ? id : undefined
}
