/**
 * The plugin's options, read defensively: `claude plugin configure` saves
 * every value as a string (a list as one string, a number as `"30"`, a bool
 * as `"false"`), so each parser accepts the real type, a JSON string, and a
 * comma/whitespace-separated string. Junk falls back to the default.
 */
import type { DeployTarget, Repo } from './model'
import { repoOf } from './shell'

/** A floating tag to keep in step with a repo's releases (`owner/repo:v1`). */
export type FloatingTag = { repo: Repo; tag: string }

export type Config = {
  releaseWorkflow: string
  registry: string
  floatingTags: FloatingTag[]
  timeoutMs: number
  pollMs: number
  deployTargets: DeployTarget[]
  sweepRepos: Repo[]
  nudge: boolean
  semverLabelGate: boolean
}

export const DEFAULTS = {
  releaseWorkflow: 'release.yml',
  registry: 'ghcr.io',
  timeoutMin: 20,
  pollSec: 30,
  semverLabelGate: true,
  nudge: false,
} as const

/** The shortest poll interval accepted, so a typo can't hammer the API. */
export const MIN_POLL_SEC = 10

/** A list option as strings: a real list, a JSON array string, or one comma/whitespace-separated string. */
export function listOf(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      return listOf(JSON.parse(value))
    } catch {
      // not JSON: fall through to the split
    }
  }
  const entries = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : []
  return entries.flatMap(e => e.split(/[\s,]+/)).filter(e => e !== '')
}

/** A number option: a number or a numeric string; else undefined. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** A boolean option: a boolean, or `true|1|yes|on` / `false|0|no|off` in any case; else the fallback. */
export function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : fallback
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(v)) return true
    if (['false', '0', 'no', 'off'].includes(v)) return false
  }
  return fallback
}

/** `floatingTagRepos` entries `owner/repo:tag`; malformed ones dropped. */
export function parseFloatingTagRepos(value: unknown): FloatingTag[] {
  const out: FloatingTag[] = []
  for (const entry of listOf(value)) {
    const colon = entry.lastIndexOf(':')
    if (colon <= 0) continue
    const repo = repoOf(entry.slice(0, colon).trim())
    const tag = entry.slice(colon + 1).trim()
    if (repo && /^[^\s~^:?*[\\]+$/.test(tag)) out.push({ repo, tag })
  }
  return out
}

/** `deployRepos` entries `owner/app=owner/deploy-repo:path/in/repo`; malformed ones dropped. */
export function parseDeployRepos(value: unknown): DeployTarget[] {
  const out: DeployTarget[] = []
  for (const entry of listOf(value)) {
    const m = /^([^=]+)=([^:]+):(.+)$/.exec(entry)
    if (!m) continue
    const appRepo = repoOf(m[1]?.trim())
    const deployRepo = repoOf(m[2]?.trim())
    const path = (m[3] as string).trim().replace(/^\/+/, '')
    if (appRepo && deployRepo && path && !path.split('/').includes('..')) out.push({ appRepo, deployRepo, path })
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
  const minutes = numberOf(o.timeoutMin)
  const timeoutMin = minutes !== undefined && minutes >= 1 ? minutes : DEFAULTS.timeoutMin
  const sec = numberOf(o.pollSec)
  const pollSec = sec !== undefined && sec > 0 ? Math.max(sec, MIN_POLL_SEC) : DEFAULTS.pollSec
  const sweepRepos: Repo[] = []
  for (const r of listOf(o.sweepRepos)) {
    const repo = repoOf(r)
    if (repo && !sweepRepos.some(s => s.toLowerCase() === repo.toLowerCase())) sweepRepos.push(repo)
  }
  return {
    releaseWorkflow: workflow,
    registry,
    floatingTags: parseFloatingTagRepos(o.floatingTagRepos),
    timeoutMs: timeoutMin * 60_000,
    pollMs: pollSec * 1000,
    deployTargets: parseDeployRepos(o.deployRepos),
    sweepRepos,
    nudge: boolOf(o.nudge, DEFAULTS.nudge),
    semverLabelGate: boolOf(o.semverLabelGate, DEFAULTS.semverLabelGate),
  }
}

/** The floating tag configured for a repo, if any (repo names compare case-insensitively). */
export function floatingTagFor(config: Config, repo: Repo): string | undefined {
  const lower = repo.toLowerCase()
  return config.floatingTags.find(f => f.repo.toLowerCase() === lower)?.tag
}

/** The deploy target configured for an app repo, if any. */
export function deployTargetFor(config: Config, repo: Repo): DeployTarget | undefined {
  const lower = repo.toLowerCase()
  return config.deployTargets.find(d => d.appRepo.toLowerCase() === lower)
}
