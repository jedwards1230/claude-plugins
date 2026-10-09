// A<->B contract for gh-monitor. Engine (hooks/engine) produces these; UI (hooks/ui) renders them. Additive changes only.
export type Repo = string                  // 'owner/name', compared case-insensitively
export type ItemId = string                // 'pr:owner/name#12' | 'rel:owner/name@<armedAt>'

export type ArmSource =
  | 'pr-create' | 'pr-cmd' | 'push' | 'url' | 'ci-watch'      // route 1
  | 'merged-event'                                            // route 2
  | 'typed-merged'                                            // route 3
  | 'dispatch' | 'run-watch' | 'release-watch' | 'release-cmd'// route 4
  | 'command'                                                 // route 5
  | 'sweep'                                                   // route 6
  | 'resume'                                                  // loaded from store

export type CiState = 'starting' | 'running' | 'failing' | 'passed' | 'none' | 'skipped'
export type ReviewState =
  | 'conflict' | 'changes' | 'draft' | 'unresolved' | 'requested'
  | 'blocked' | 'behind' | 'approved-ready' | 'ready' | 'approved' | 'unknown'

export type CheckView = {
  name: string
  state: 'pass' | 'fail' | 'pending' | 'skip'
  url?: string
  startedAt?: number
  completedAt?: number
}

export type PrView = {
  ci: CiState
  passed: number; failed: number; pending: number; total: number
  failing: string[]          // failing check names, rollup order, deduped
  checks: CheckView[]        // for the pane
  review: ReviewState
  unresolved: number
  isDraft: boolean
  headSha?: string
}

export type ReleaseStage = 'run' | 'tag' | 'release' | 'artifacts'

export type ArtifactView = {
  image?: { pkg: string; digest?: string }        // pkg 'owner/name'; digest set once seen
  chart?: { pkg: string; version?: string }       // pkg 'owner/charts/name'; version set once seen
}

export type ReleaseView = {
  stage: ReleaseStage
  step: number               // 1-based position of `stage` among the stages that apply
  total: 3 | 4               // 4 when any artifact applies
  workflow: string           // display: the file name, e.g. 'release.yml'
  runStatus?: 'queued' | 'in_progress' | 'waiting' | 'pending' | 'requested' | 'completed'
  runUrl?: string
  runStartedAt?: number
  tag?: string
  artifacts?: ArtifactView
  floatingTag?: string       // configured floating tag for this repo
  wantTag?: string           // /watch-release --tag
  deadline: number
}

export type Outcome =
  | { kind: 'published'; tag: string; image?: string; chart?: string }  // Release + every artifact that applies
  | { kind: 'released'; tag: string; missing?: ('image' | 'chart')[] }  // Release out; no artifacts apply, or some never appeared by deadline
  | { kind: 'tagged-only'; tag: string }                               // tag, no GitHub Release within grace
  | { kind: 'no-semver-label' }
  | { kind: 'not-default-branch'; base: string }
  | { kind: 'no-release-workflow'; workflow: string }
  | { kind: 'no-version-cut'; workflow: string }                       // run succeeded/skipped, no new tag
  | { kind: 'no-run'; workflow: string }                               // gate off and no run within grace
  | { kind: 'failed'; workflow: string; conclusion: string; url?: string }
  | { kind: 'timeout'; stage: ReleaseStage; minutes: number }
  | { kind: 'closed' }                                                 // PR closed without merging
  | { kind: 'gone' }                                                   // PR not found

export type DeployTarget = { appRepo: Repo; deployRepo: Repo; path: string }
export type DeployOffer = {
  target: DeployTarget
  version: string            // tag as released, e.g. 'v0.47.9'
  image?: string             // 'ghcr.io/owner/name:v0.47.9'
  chartVersion?: string      // '0.47.9'
  state: 'offered' | 'filled' | 'dismissed'
}

export type Item = {
  id: ItemId
  repo: Repo
  pr?: number
  title?: string
  url?: string
  source: ArmSource
  phase: 'pr' | 'release' | 'done'
  armedAt: number
  lastTransitionAt: number   // words changed (not just counts/elapsed)
  prView?: PrView            // phase 'pr' (kept, frozen, after merge)
  mergedAt?: number
  release?: ReleaseView      // phase 'release' (kept, frozen, once done)
  outcome?: Outcome          // phase 'done'
  doneAt?: number
  deploy?: DeployOffer
  errorStreak: number        // consecutive failed reads; >= 3 => UI shows "can't reach GitHub"
}

export type Snapshot = { now: number; items: readonly Item[] }   // items sorted: see §3.4

export type MonitorEvent =
  | { kind: 'checks-failed'; item: Item; names: string[] }
  | { kind: 'checks-passed'; item: Item }
  | { kind: 'changes-requested'; item: Item }
  | { kind: 'merged'; item: Item }          // item.phase already 'release' or 'done' (immediate outcome)
  | { kind: 'outcome'; item: Item }         // item.outcome set (release or PR terminal)
  | { kind: 'floating-tag-stale'; item: Item; tag: string }
  | { kind: 'deploy-offer'; item: Item }    // item.deploy set, state 'offered'
