/**
 * Every string gh-monitor shows: the status line, the band's rows, the pane's
 * lines, the toasts and the deploy prompt. Pure: it reads the engine's
 * Snapshot / MonitorEvent (../engine/model) and never touches `$`.
 *
 * Plain language, one format everywhere: `<repo> #<pr> · <step>/<total> ·
 * <phrase>`, owner dropped, the stage names `workflow · tag · GitHub release ·
 * image / chart` the same on every surface.
 *
 * Widths are terminal cells (`width`: CJK and emoji 2, marks and ZWJ 0). The status
 * text is at most STATUS_MAX: Claude Code itself prefixes ` ⚠ gh-monitor: `,
 * so nothing here adds a prefix. A row too long is shortened in a fixed order
 * (`fit`): repo name, elapsed time, version, phrase level, name again and the
 * check list, tiniest phrase, then a hard cut ending in `…`.
 */
import type {
  CheckView,
  CiState,
  Item,
  ItemId,
  MonitorEvent,
  Outcome,
  PrView,
  ReleaseStage,
  ReleaseView,
  ReviewState,
  Snapshot,
} from '../engine/model'

/** 82 columns less the 16 the engine's ` ⚠ gh-monitor: ` prefix may take (`⚠` can draw two cells). */
export const STATUS_MAX = 66
export const TOAST_MAX = 100
/** A finished item stays on the band this long. */
export const DONE_LINGER_MS = 600_000
/** A deploy offer stops being offered this long after the release finished. */
export const OFFER_TTL_MS = 3_600_000
/** Consecutive failed reads before a row says GitHub can't be reached. */
export const OFFLINE_STREAK = 3
/** Below this many band columns the row markers are dropped. */
export const MARKER_MIN_COLUMNS = 40
/** Buttons are dropped when they would leave a row's text less than this. */
export const MIN_TEXT_WITH_BUTTONS = 24
/** `[ bump ]` and `[ x ]` as the terminal draws them, each after a one-cell gap. */
export const BUMP_CELLS = 8
export const X_CELLS = 5

export type Level = 'full' | 'compact' | 'tiny'

/** What the toasts need from the plugin's options. */
export type ToastConfig = { timeoutMs: number; releaseWorkflow: string }

// ---------------------------------------------------------------------------
// width helpers

/** East Asian Wide / Fullwidth blocks (Hangul jamo, CJK, kana, Hangul syllables, fullwidth forms, CJK ext.). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]
/** Joins the next code point into the current cluster (emoji ZWJ sequences). */
const ZWJ = 0x200d
/** Asks for emoji presentation: a narrow base becomes two cells. */
const VS16 = 0xfe0f
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}]$/u
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u
const REGIONAL = /^\p{Regional_Indicator}$/u

function codeWidth(ch: string): number {
  const cp = ch.codePointAt(0) as number
  if (ZERO_WIDTH.test(ch)) return 0
  if (EMOJI_WIDE.test(ch)) return 2
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2
  return 1
}

/**
 * The string as terminal clusters with the cells each takes: a base and the
 * marks, variation selectors, skin tones and ZWJ-joined code points after it
 * (an emoji ZWJ sequence draws as one glyph), a regional-indicator pair (a
 * flag). Wide (CJK, emoji presentation) is 2, VS16 widens a narrow base to 2,
 * combining marks and ZWJ are 0. `⚠` and the markers here have text
 * presentation and stay 1.
 */
export function clusters(s: string): { text: string; cells: number }[] {
  const out: { text: string; cells: number }[] = []
  let isJoining = false
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    const last = out[out.length - 1]
    if (last && (isJoining || ZERO_WIDTH.test(ch))) {
      last.text += ch
      if (cp === VS16 && last.cells === 1) last.cells = 2
      isJoining = cp === ZWJ
      continue
    }
    if (last && REGIONAL.test(ch) && REGIONAL.test(last.text) && [...last.text].length === 1) {
      last.text += ch
      last.cells = 2
      continue
    }
    isJoining = cp === ZWJ
    out.push({ text: ch, cells: REGIONAL.test(ch) ? 1 : codeWidth(ch) })
  }
  return out
}

/** Tabs and line breaks (from a check name or a PR title) as single spaces: every row is one line. */
export function oneLine(s: string): string {
  return s.replace(/[\t\r\n\v\f]+/g, ' ')
}

/** Terminal cells a string takes (see clusters). */
export function width(s: string): number {
  let n = 0
  for (const c of clusters(s)) n += c.cells
  return n
}

/** Cuts `s` to at most `n` cells on a cluster boundary, ending in `…` (one cell) when cut. */
export function elide(s: string, n: number): string {
  if (width(s) <= n) return s
  if (n <= 0) return ''
  let text = ''
  let used = 0
  for (const c of clusters(s)) {
    if (used + c.cells > n - 1) break
    text += c.text
    used += c.cells
  }
  return `${text}…`
}

/** `acme/widget` -> `widget`: the owner is never shown in a row, status or toast. */
export function shortName(repo: string): string {
  const i = repo.indexOf('/')
  return i < 0 ? repo : repo.slice(i + 1)
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

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------------------------------------------------------------------------
// phrases (design §3.3)

/** The knobs `fit` turns, from roomiest to tightest. */
type Shape = {
  nameMax: number
  verMax: number
  isElapsed: boolean
  level: Level
  isChecksShort: boolean
}

const ROOMY: Shape = { nameMax: Infinity, verMax: Infinity, isElapsed: true, level: 'full', isChecksShort: false }

export function ciPart(v: PrView, level: Level, isChecksShort = false): string {
  const done = v.total - v.pending
  const ci: CiState = v.ci
  switch (ci) {
    case 'starting':
      return level === 'tiny' ? 'starting' : 'checks starting'
    case 'running':
      return level === 'full'
        ? `checks running ${done}/${v.total}`
        : level === 'compact'
          ? `running ${done}/${v.total}`
          : `${done}/${v.total}`
    case 'failing': {
      if (level === 'tiny') return 'failing'
      const names = v.failing
      if (names.length === 0) return level === 'full' ? 'checks failing' : 'failing'
      const list =
        level === 'full' && !isChecksShort
          ? names.join(', ')
          : `${isChecksShort ? elide(names[0] as string, 16) : names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`
      return level === 'full' ? `checks failing: ${list}` : `failing: ${list}`
    }
    case 'passed':
      return level === 'full' ? 'checks passed' : level === 'compact' ? 'passed' : 'ok'
    case 'none':
      return level === 'full' ? 'no checks configured' : 'no checks'
    case 'skipped':
      return level === 'full' ? 'checks skipped' : 'skipped'
  }
}

export function reviewPart(v: PrView, level: Level): string {
  const r: ReviewState = v.review
  switch (r) {
    case 'conflict':
      return level === 'full' ? 'merge conflict' : 'conflict'
    case 'changes':
      return level === 'tiny' ? 'changes' : 'changes requested'
    case 'draft':
      return 'draft'
    case 'unresolved':
      return level === 'full'
        ? `${plural(v.unresolved, 'unresolved comment')}`
        : level === 'compact'
          ? `${v.unresolved} unresolved`
          : `${v.unresolved} unres.`
    case 'requested':
    case 'unknown':
      return level === 'full' ? 'waiting for review' : level === 'compact' ? 'in review' : 'review'
    case 'blocked':
      return level === 'full' ? 'blocked from merging' : 'blocked'
    case 'behind':
      return level === 'full' ? 'branch behind base' : level === 'compact' ? 'behind base' : 'behind'
    case 'approved-ready':
      return level === 'full' ? 'approved, ready to merge' : level === 'compact' ? 'ready to merge' : 'ready'
    case 'ready':
      return level === 'tiny' ? 'ready' : 'ready to merge'
    case 'approved':
      return 'approved'
  }
}

/** The PR phase's parts in order: CI first, but a conflict or requested changes lead while CI is not failing. */
export function prParts(v: PrView, level: Level, isChecksShort = false): string[] {
  const ci = ciPart(v, level, isChecksShort)
  const review = reviewPart(v, level)
  const isLeading = (v.review === 'conflict' || v.review === 'changes') && v.ci !== 'failing'
  return isLeading ? [review, ci] : [ci, review]
}

/** The artifacts a release still waits for, `image + chart`, `image` or `chart`. */
function pendingArtifacts(rel: ReleaseView): string {
  const a = rel.artifacts ?? {}
  const pending = [
    ...(a.image && !a.image.digest ? ['image'] : []),
    ...(a.chart && !a.chart.version ? ['chart'] : []),
  ]
  const named = pending.length > 0 ? pending : [...(a.image ? ['image'] : []), ...(a.chart ? ['chart'] : [])]
  return named.length > 0 ? named.join(' + ') : 'image'
}

/** How the stages read everywhere: workflow · tag · GitHub release · image / chart. */
export function stageName(stage: ReleaseStage, rel?: ReleaseView): string {
  switch (stage) {
    case 'run':
      return 'workflow'
    case 'tag':
      return 'tag'
    case 'release':
      return 'GitHub release'
    case 'artifacts':
      return rel ? pendingArtifacts(rel) : 'image / chart'
  }
}

export function releasePhrase(rel: ReleaseView, level: Level, ver: string, elapsed: string): string {
  switch (rel.stage) {
    case 'run': {
      const s = rel.runStatus
      if (s === undefined) {
        if (rel.floatingTag) {
          return level === 'full'
            ? `dispatch ${rel.workflow} to move ${rel.floatingTag}`
            : `dispatch to move ${rel.floatingTag}`
        }
        return level === 'full' ? 'waiting for workflow to start' : level === 'compact' ? 'waiting for workflow' : 'waiting'
      }
      if (s === 'in_progress') {
        if (level === 'tiny') return 'running'
        return level === 'full' && elapsed ? `workflow running ${elapsed}` : 'workflow running'
      }
      if (s === 'completed') return level === 'tiny' ? 'done' : 'workflow done'
      return level === 'full' ? 'workflow queued' : 'queued'
    }
    case 'tag':
      return level === 'full' ? 'workflow done, waiting for tag' : 'waiting for tag'
    case 'release':
      if (level === 'tiny') return 'waiting for release'
      return level === 'full'
        ? `tagged ${ver}, waiting for GitHub release`
        : `tagged ${ver}, waiting for release`
    case 'artifacts': {
      const what = pendingArtifacts(rel)
      return level === 'full' ? `${ver} released, waiting for ${what}` : `waiting for ${what}`
    }
  }
}

/** The phrase for a finished item (band, pane, single-item status). */
export function outcomePhrase(o: Outcome, level: Level, ver: (tag: string) => string = t => t): string {
  switch (o.kind) {
    case 'published':
      return `${ver(o.tag)} published`
    case 'released':
      return o.missing && o.missing.length > 0 && level !== 'tiny'
        ? `${ver(o.tag)} released, no ${o.missing.join(' or ')}`
        : `${ver(o.tag)} released`
    case 'tagged-only':
      return level === 'full' ? `tagged ${ver(o.tag)}, no GitHub release` : `tagged ${ver(o.tag)}, no release`
    case 'no-semver-label':
      return level === 'full'
        ? 'merged · no release expected (no semver label)'
        : level === 'compact'
          ? 'merged · no release expected'
          : 'no release'
    case 'not-default-branch':
      return level === 'full' ? `merged into ${o.base} · no release expected` : `merged into ${o.base}`
    case 'no-release-workflow':
      return level === 'tiny' ? 'no release workflow' : 'merged · no release workflow'
    case 'no-version-cut':
      return level === 'full' ? 'workflow ran, cut no version' : 'no new version'
    case 'no-run':
      return level === 'full' ? 'release workflow never started' : 'workflow never started'
    case 'failed':
      return level === 'full' ? 'release workflow failed' : 'workflow failed'
    case 'timeout':
      return level === 'full'
        ? `gave up after ${o.minutes} min (${stageName(o.stage)})`
        : `gave up (${stageName(o.stage)})`
    case 'closed':
      return level === 'full' ? 'closed without merging' : 'closed'
    case 'gone':
      return level === 'full' ? 'PR not found' : 'not found'
  }
}

// ---------------------------------------------------------------------------
// classification (markers, ordering, status counts)

export type Tone = 'bad' | 'busy' | 'wait' | 'good' | 'neutral' | 'offer'

const MARKERS: Record<Tone, string> = { bad: '✗', busy: '●', wait: '◐', good: '✓', neutral: '·', offer: '↑' }

export function markerOf(tone: Tone): string {
  return MARKERS[tone]
}

const BAD_OUTCOMES: ReadonlySet<Outcome['kind']> = new Set(['failed', 'timeout'])
const GOOD_OUTCOMES: ReadonlySet<Outcome['kind']> = new Set(['published', 'released'])

export function isOfferActive(item: Item, now: number): boolean {
  return item.deploy?.state === 'offered' && (item.doneAt === undefined || now - item.doneAt < OFFER_TTL_MS)
}

/** Live: still being watched (PR or release phase), or a deploy offer waiting on the person. */
export function isLive(item: Item, now: number): boolean {
  return item.phase === 'pr' || item.phase === 'release' || isOfferActive(item, now)
}

/** Shown on the band: live, or finished within DONE_LINGER_MS. */
export function isOnBand(item: Item, now: number): boolean {
  return isLive(item, now) || (item.phase === 'done' && now - (item.doneAt ?? item.lastTransitionAt) < DONE_LINGER_MS)
}

export function toneOf(item: Item, now: number): Tone {
  if (isOfferActive(item, now)) return 'offer'
  if (item.phase === 'done') {
    const k = item.outcome?.kind
    if (k && BAD_OUTCOMES.has(k)) return 'bad'
    if (k && GOOD_OUTCOMES.has(k)) return 'good'
    return 'neutral'
  }
  if (item.phase === 'release') return 'busy'
  const v = item.prView
  if (!v) return 'busy'
  if (v.ci === 'failing' || v.review === 'conflict' || v.review === 'changes') return 'bad'
  if (v.ci === 'starting' || v.ci === 'running') return 'busy'
  if (v.review === 'approved-ready' || v.review === 'ready' || v.review === 'approved') return 'good'
  return 'wait'
}

/** Sort rank (design §3.4): failures, offers, releasing, checks running, in review/ready, done. */
function rankOf(item: Item, now: number): number {
  const tone = toneOf(item, now)
  if (tone === 'bad') return 0
  if (tone === 'offer') return 1
  if (item.phase === 'release') return 2
  if (item.phase === 'pr' && (item.prView?.ci === 'starting' || item.prView?.ci === 'running' || !item.prView)) {
    return 3
  }
  if (item.phase === 'pr') return 4
  return 5
}

export function sortItems(items: readonly Item[], now: number): Item[] {
  return [...items].sort((a, b) => {
    const r = rankOf(a, now) - rankOf(b, now)
    if (r !== 0) return r
    if (a.phase === 'done' && b.phase === 'done') {
      const d = (b.doneAt ?? 0) - (a.doneAt ?? 0)
      if (d !== 0) return d
    }
    return b.lastTransitionAt - a.lastTransitionAt
  })
}

// ---------------------------------------------------------------------------
// one row

/** `widget #12`, or `widget` for a release with no PR. */
function labelOf(item: Item, nameMax: number): string {
  const name = elide(shortName(item.repo), nameMax)
  return item.pr !== undefined ? `${name} #${item.pr}` : name
}

function versionOf(item: Item): string {
  return item.release?.tag ?? item.release?.wantTag ?? item.deploy?.version ?? ''
}

function render(item: Item, now: number, s: Shape): string {
  const ver = (v: string) => elide(v, s.verMax)
  if (isOfferActive(item, now) && item.deploy) {
    const d = item.deploy
    return `${elide(shortName(item.repo), s.nameMax)} ${ver(d.version)} → ${elide(shortName(d.target.deployRepo), s.nameMax)}`
  }
  const label = labelOf(item, s.nameMax)
  const offline =
    item.phase !== 'done' && item.errorStreak >= OFFLINE_STREAK
      ? s.level === 'full'
        ? " · can't reach GitHub"
        : ' · offline'
      : ''
  if (item.phase === 'done') {
    const phrase = item.outcome ? outcomePhrase(item.outcome, s.level, ver) : 'done'
    return `${label} · ${phrase}`
  }
  if (item.phase === 'release' && item.release) {
    const rel = item.release
    const elapsed = s.isElapsed && rel.runStartedAt !== undefined ? formatElapsed(now - rel.runStartedAt) : ''
    const phrase = releasePhrase(rel, s.level, ver(versionOf(item)), elapsed)
    return `${label} · ${rel.step}/${rel.total} · ${phrase}${offline}`
  }
  if (item.prView) {
    return `${label} · ${prParts(item.prView, s.level, s.isChecksShort).join(' · ')}${offline}`
  }
  return `${label} · ${s.level === 'tiny' ? 'starting' : 'checks starting'}${offline}`
}

/**
 * Renders with progressively tighter shapes until the text fits `max`; a
 * shrink only takes what is needed (never below its minimum).
 */
function fitWith(draw: (s: Shape) => string, nameOf: () => string, verOf: () => string, max: number): string {
  const build = (shape: Shape) => oneLine(draw(shape))
  let s: Shape = { ...ROOMY }
  const over = () => width(build(s)) - max
  const shrink = (key: 'nameMax' | 'verMax', full: string, min: number) => {
    const o = over()
    if (o <= 0) return
    const len = width(full)
    s = { ...s, [key]: Math.max(min, Math.min(s[key], len) - o) }
  }
  if (over() <= 0) return build(s)
  shrink('nameMax', nameOf(), 14)
  if (over() > 0) s = { ...s, isElapsed: false }
  shrink('verMax', verOf(), 10)
  if (over() > 0) s = { ...s, level: 'compact' }
  shrink('nameMax', nameOf(), 6)
  if (over() > 0) s = { ...s, isChecksShort: true }
  if (over() > 0) s = { ...s, level: 'tiny' }
  return elide(build(s), max)
}

/** One item as a row of at most `max` cells. */
export function rowText(item: Item, now: number, max: number): string {
  return fitWith(
    s => render(item, now, s),
    () => shortName(item.repo),
    () => versionOf(item),
    max,
  )
}

// ---------------------------------------------------------------------------
// status line (design §3.5)

type Bucket = 'failing' | 'running' | 'review' | 'ready'

function prBucket(v: PrView | undefined): Bucket {
  if (!v) return 'running'
  if (v.ci === 'failing') return 'failing'
  if (v.ci === 'starting' || v.ci === 'running') return 'running'
  if (
    (v.review === 'approved-ready' || v.review === 'ready' || v.review === 'approved') &&
    (v.ci === 'passed' || v.ci === 'none' || v.ci === 'skipped')
  ) {
    return 'ready'
  }
  return 'review'
}

/**
 * The status line: cleared when nothing is live, one item's row when one is,
 * else a summary (`3 PRs · 1 failing (widget) · 2 in review · 1 releasing`)
 * whose terms are dropped from the right to fit, `failing` always kept.
 */
export function statusLine(snap: Snapshot, max = STATUS_MAX): string | undefined {
  const now = snap.now
  const live = snap.items.filter(i => isLive(i, now))
  if (live.length === 0) return undefined
  if (live.length === 1) return rowText(live[0] as Item, now, max)

  const prs = live.filter(i => i.phase === 'pr')
  const count = (b: Bucket) => prs.filter(i => prBucket(i.prView) === b).length
  const recentFailed = snap.items.filter(
    i => i.phase === 'done' && i.outcome?.kind === 'failed' && now - (i.doneAt ?? 0) < DONE_LINGER_MS,
  )
  const failingItems = [...prs.filter(i => prBucket(i.prView) === 'failing'), ...recentFailed]
  const f = failingItems.length
  const releasing = live.filter(i => i.phase === 'release').length
  const offers = live.filter(i => isOfferActive(i, now)).length

  const failing = (withName: boolean) =>
    f === 0 ? '' : withName && f === 1 ? `1 failing (${shortName((failingItems[0] as Item).repo)})` : `${f} failing`
  const tail = [
    count('running') > 0 ? `${count('running')} running` : '',
    count('review') > 0 ? `${count('review')} in review` : '',
    count('ready') > 0 ? `${count('ready')} ready` : '',
    releasing > 0 ? `${releasing} releasing` : '',
    offers > 0 ? `${offers} to deploy` : '',
  ].filter(t => t !== '')
  const head = prs.length > 0 ? plural(prs.length, 'PR') : ''

  const join = (withName: boolean, keep: number) =>
    [head, failing(withName), ...tail.slice(0, keep)].filter(t => t !== '').join(' · ')
  // Every term outranks the failing repo's name: drop the name first, then terms from the right.
  for (let keep = tail.length; keep >= 0; keep--) {
    for (const withName of [true, false]) {
      const text = join(withName, keep)
      if (width(text) <= max) return text
    }
  }
  return elide(join(false, 0), max)
}

// ---------------------------------------------------------------------------
// toasts (design §3.3 "Other toasts")

export type Toast = { text: string; timeoutMs: number }

/** Builds a toast from a name-less template, eliding the name first and then the tail to TOAST_MAX. */
function fitToast(item: Item, build: (label: string) => string): string {
  const full = shortName(item.repo)
  const make = (n: number) => oneLine(build(labelOf({ ...item, repo: elide(full, n) }, Infinity)))
  let text = make(Infinity)
  const over = width(text) - TOAST_MAX
  if (over > 0) text = make(Math.max(6, width(full) - over))
  return elide(text, TOAST_MAX)
}

function listNames(names: readonly string[], max: number): string {
  const all = names.join(', ')
  if (width(all) <= max || names.length <= 1) return all
  return `${elide(names[0] as string, 24)} +${names.length - 1}`
}

/** The toast for one outcome, and how long it shows. */
export function outcomeToast(item: Item, config: ToastConfig): Toast | undefined {
  const o = item.outcome
  if (!o) return undefined
  const minutes = Math.round(config.timeoutMs / 60_000)
  const wf = (w: string) => w || config.releaseWorkflow
  const t = (build: (l: string) => string, timeoutMs: number): Toast => ({ text: fitToast(item, build), timeoutMs })
  switch (o.kind) {
    case 'published': {
      const parts = ['GitHub release', ...(o.image ? ['image'] : []), ...(o.chart ? ['chart'] : [])]
      return t(l => `${l}: ${o.tag} published (${parts.join(' + ')})`, 8000)
    }
    case 'released':
      return o.missing && o.missing.length > 0
        ? t(l => `${l}: ${o.tag} released; no ${o.missing?.join(' or ')} after ${minutes} min`, 8000)
        : t(l => `${l}: ${o.tag} released (GitHub release)`, 8000)
    case 'tagged-only':
      return t(l => `${l}: tagged ${o.tag}, but no GitHub release appeared`, 6000)
    case 'no-semver-label':
      return t(l => `${l}: merged — no release expected (no semver label)`, 6000)
    case 'not-default-branch':
      return t(l => `${l}: merged into ${o.base} — no release expected`, 6000)
    case 'no-release-workflow':
      return t(l => `${l}: merged — repo has no release workflow (${wf(o.workflow)})`, 6000)
    case 'no-version-cut':
      return t(l => `${l}: ${wf(o.workflow)} ran but cut no new version`, 6000)
    case 'no-run':
      return t(l => `${l}: ${wf(o.workflow)} never started — stopped watching`, 6000)
    case 'failed':
      return t(l => `${l}: ${wf(o.workflow)} failed (${o.conclusion})`, 10000)
    case 'timeout':
      return t(l => `${l}: gave up after ${o.minutes} min waiting for the ${stageName(o.stage, item.release)}`, 10000)
    case 'closed':
      return t(l => `${l}: closed without merging`, 6000)
    case 'gone':
      return undefined
  }
}

/** The toast for one engine event; undefined for the quiet ones. */
export function toastFor(ev: MonitorEvent, config: ToastConfig): Toast | undefined {
  const item = ev.item
  switch (ev.kind) {
    case 'checks-failed': {
      const names = ev.names.length > 0 ? ev.names : (item.prView?.failing ?? [])
      return {
        text: fitToast(item, l =>
          names.length > 0 ? `${l}: checks failed — ${listNames(names, 60)}` : `${l}: checks failed`,
        ),
        timeoutMs: 8000,
      }
    }
    case 'checks-passed':
      return { text: fitToast(item, l => `${l}: all checks passed`), timeoutMs: 4000 }
    case 'changes-requested':
      return { text: fitToast(item, l => `${l}: changes requested`), timeoutMs: 6000 }
    case 'merged': {
      if (item.phase === 'done') {
        const t = outcomeToast(item, config)
        return t ? { text: t.text, timeoutMs: 6000 } : undefined
      }
      return { text: fitToast(item, l => `${l}: merged — watching the release`), timeoutMs: 4000 }
    }
    case 'outcome':
      return outcomeToast(item, config)
    case 'floating-tag-stale': {
      const wf = item.release?.workflow || config.releaseWorkflow
      return {
        text: fitToast(item, l => `${l}: floating tag ${ev.tag} not moved — dispatch ${wf}`),
        timeoutMs: 10000,
      }
    }
    case 'deploy-offer': {
      const d = item.deploy
      if (!d) return undefined
      const deployName = shortName(d.target.deployRepo)
      const noPr = { ...item, pr: undefined }
      return {
        text: fitToast(noPr, l => `${l} ${d.version} is out — [ bump ] on the band drafts the ${deployName} bump`),
        timeoutMs: 10000,
      }
    }
  }
}

/**
 * The toasts for one batch of events. A merge with an immediate outcome
 * yields one toast (the outcome's), not "merged" and the outcome both.
 */
export function toastsFor(events: readonly MonitorEvent[], config: ToastConfig): Toast[] {
  const seen = new Set<string>()
  const out: Toast[] = []
  for (const ev of events) {
    const t = toastFor(ev, config)
    if (!t) continue
    const k = `${ev.item.id}\u0000${t.text}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

// ---------------------------------------------------------------------------
// deploy hand-off (design §3.9)

/** The request the band's `[ bump ]` drafts in the prompt box. Never sent by the plugin. */
export function deployPrompt(item: Item): string {
  const d = item.deploy
  if (!d) return ''
  const bits = [...(d.image ? [`image ${d.image}`] : []), ...(d.chartVersion ? [`chart ${d.chartVersion}`] : [])]
  const what = bits.length > 0 ? ` (${bits.join(', ')})` : ''
  return `Bump ${d.target.path} in ${d.target.deployRepo} to ${shortName(d.target.appRepo)} ${d.version}${what} and open a PR for review. Don't merge it.`
}

// ---------------------------------------------------------------------------
// band (design §3.2-3.4)

/** `prompt` is the deploy request a `bump` drafts (deployPrompt), fixed when the row was built. */
export type BandButton = { key: string; label: string; hotkey?: string; action: 'bump' | 'dismiss'; prompt?: string }
export type BandRow = {
  key: string
  id?: ItemId
  /** Empty when the band is too narrow for markers. */
  marker: string
  tone: Tone
  text: string
  isDim: boolean
  buttons: BandButton[]
}

export const OVERFLOW_KEY = 'more'

/** The band's rows, or none when nothing is active. Every row's cells fit `columns`. */
export function bandRows(snap: Snapshot, columns: number, maxRows: number): BandRow[] {
  const now = snap.now
  const shown = sortItems(
    snap.items.filter(i => isOnBand(i, now)),
    now,
  )
  const cap = Number.isFinite(maxRows) ? Math.floor(maxRows) : 0
  const cols = Number.isFinite(columns) ? Math.floor(columns) : 0
  // No room for even one cell, or no rows to draw in: draw nothing rather than overflow.
  if (shown.length === 0 || cap < 1 || cols < 1) return []
  const isOverflow = shown.length > cap
  const visible = isOverflow ? shown.slice(0, cap - 1) : shown
  const markerCells = cols >= MARKER_MIN_COLUMNS ? 2 : 0
  const room = cols - markerCells

  const rows: BandRow[] = visible.map((item, index) => {
    const tone = toneOf(item, now)
    const wantsButtons = tone === 'offer'
    const buttonCells = wantsButtons ? 1 + BUMP_CELLS + 1 + X_CELLS : 0
    const hasButtons = wantsButtons && room - buttonCells >= MIN_TEXT_WITH_BUTTONS
    const textMax = hasButtons ? room - buttonCells : room
    const hotkey = index < 9 ? String(index + 1) : undefined
    return {
      key: item.id,
      id: item.id,
      marker: markerCells > 0 ? markerOf(tone) : '',
      tone,
      text: rowText(item, now, textMax),
      isDim: item.phase === 'done' && tone !== 'offer',
      buttons: hasButtons
        ? [
            { key: `bump:${item.id}`, label: 'bump', ...(hotkey ? { hotkey } : {}), action: 'bump', prompt: deployPrompt(item) },
            { key: `x:${item.id}`, label: 'x', action: 'dismiss' },
          ]
        : [],
    }
  })
  if (isOverflow) {
    const n = shown.length - visible.length
    const roomy = `+${n} more · /gh-monitor for all`
    const text = width(roomy) <= room ? roomy : elide(`+${n} more`, room)
    rows.push({ key: OVERFLOW_KEY, marker: markerCells > 0 ? ' ' : '', tone: 'neutral', text, isDim: true, buttons: [] })
  }
  return rows
}

/** Cells a band row takes as drawn: marker and space, text, each button with its gap. */
export function bandRowCells(row: BandRow): number {
  const marker = row.marker ? 2 : 0
  const buttons = row.buttons.reduce((n, b) => n + 1 + (b.action === 'bump' ? BUMP_CELLS : X_CELLS), 0)
  return marker + width(row.text) + buttons
}

// ---------------------------------------------------------------------------
// pane (design §2.4, §5.3)

export type PaneLine = { key: string; text: string; tone?: Tone; isDim?: boolean; href?: string }
export type PaneButton = { key: string; label: string; action: 'stop' | 'bump' | 'dismiss'; prompt?: string }
export type PaneBlock = { key: string; id: ItemId; header: string; lines: PaneLine[]; buttons: PaneButton[] }

const CHECK_MARK: Record<CheckView['state'], { glyph: string; tone: Tone }> = {
  pass: { glyph: '✓', tone: 'good' },
  fail: { glyph: '✗', tone: 'bad' },
  pending: { glyph: '●', tone: 'busy' },
  skip: { glyph: '·', tone: 'neutral' },
}

function checkTiming(c: CheckView, now: number): string {
  if (c.startedAt === undefined) return ''
  return c.completedAt !== undefined
    ? ` (${formatElapsed(c.completedAt - c.startedAt)})`
    : ` (running ${formatElapsed(now - c.startedAt)})`
}

/** A URL a Link accepts: https (or http://localhost), printable ASCII, no `@`. */
export function linkable(url: string | undefined): string | undefined {
  if (!url || url.length > 2048) return undefined
  if (!/^https:\/\/[\x21-\x7e]+$/.test(url) || url.includes('@')) return undefined
  return url
}

/** Every item, newest work first, with full detail; each line fit to `columns`. */
export function paneBlocks(snap: Snapshot, columns: number): PaneBlock[] {
  const now = snap.now
  const cols = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0
  const fit = (s: string) => elide(oneLine(s), cols)
  return sortItems(snap.items, now).map(item => {
    const lines: PaneLine[] = []
    const add = (key: string, text: string, extra: Omit<PaneLine, 'key' | 'text'> = {}) =>
      lines.push({ key: `${item.id}:${key}`, text: fit(text), ...extra })
    const tone = toneOf(item, now)
    add('row', `${markerOf(tone)} ${rowText(item, now, Math.max(0, cols - 2))}`, { tone })

    const v = item.prView
    if (v) {
      const counts = [
        v.passed ? `${v.passed} passed` : '',
        v.failed ? `${v.failed} failing` : '',
        v.pending ? `${v.pending} running` : '',
      ].filter(Boolean)
      add('checks', `checks: ${counts.length > 0 ? counts.join(' · ') : ciPart(v, 'full')}`)
      for (const [i, c] of v.checks.entries()) {
        const m = CHECK_MARK[c.state]
        const href = linkable(c.url)
        add(`check${i}`, `  ${m.glyph} ${c.name}${checkTiming(c, now)}`, { tone: m.tone, ...(href ? { href } : {}) })
      }
      add('review', `review: ${reviewPart(v, 'full')}${v.unresolved > 0 && v.review !== 'unresolved' ? ` · ${plural(v.unresolved, 'unresolved comment')}` : ''}`)
    }
    if (item.mergedAt !== undefined) add('merged', `merged ${formatElapsed(now - item.mergedAt)} ago`, { isDim: true })

    const rel = item.release
    if (rel) {
      const runHref = linkable(rel.runUrl)
      add('workflow', `workflow: ${rel.workflow}${rel.runStatus ? ` (${rel.runStatus.replace(/_/g, ' ')})` : ''}`, runHref ? { href: runHref } : {})
      if (rel.runStartedAt !== undefined) add('run', `run started ${formatElapsed(now - rel.runStartedAt)} ago`, { isDim: true })
      if (rel.tag) add('tag', `tag: ${rel.tag}`)
      if (rel.artifacts?.image) {
        add('image', `image: ${rel.artifacts.image.pkg} ${rel.artifacts.image.digest ?? '(waiting)'}`)
      }
      if (rel.artifacts?.chart) {
        add('chart', `chart: ${rel.artifacts.chart.pkg} ${rel.artifacts.chart.version ?? '(waiting)'}`)
      }
      if (item.phase === 'release') {
        const left = rel.deadline - now
        add('deadline', left > 0 ? `gives up in ${formatElapsed(left)}` : 'giving up', { isDim: true })
      }
    }
    if (item.outcome?.kind === 'failed' && linkable(item.outcome.url)) {
      add('failed', `failed run: ${item.outcome.url}`, { tone: 'bad', href: linkable(item.outcome.url) as string })
    }
    if (item.deploy) {
      add('deploy', `deploy: ${item.deploy.target.deployRepo} ${item.deploy.target.path} (${item.deploy.state})`)
    }

    const buttons: PaneButton[] = []
    if (item.phase !== 'done') buttons.push({ key: `stop:${item.id}`, label: 'stop', action: 'stop' })
    if (isOfferActive(item, now)) {
      buttons.push({ key: `bump:${item.id}`, label: 'bump', action: 'bump', prompt: deployPrompt(item) })
      buttons.push({ key: `x:${item.id}`, label: 'x', action: 'dismiss' })
    }
    const header = fit(`${item.repo}${item.pr !== undefined ? ` #${item.pr}` : ''}${item.title ? ` — ${item.title}` : ''}`)
    return { key: item.id, id: item.id, header, lines, buttons }
  })
}
