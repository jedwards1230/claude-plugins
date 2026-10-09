/**
 * Persistence: one store key per session holding every watch, so a restart
 * or module reload resumes where it was. Pure helpers; the engine does the
 * reads and writes through its Host.
 */

export const KEY_PREFIX = 'gh-monitor:v1:'
/** Done items older than this are not restored. */
export const DONE_KEEP_MS = 60 * 60_000
/** Another session's key untouched this long is deleted at boot. */
export const FOREIGN_KEEP_MS = 7 * 24 * 60 * 60_000
/** The most one session's payload may take (the plugin's whole store is 4 MiB). */
export const MAX_PAYLOAD = 256 * 1024
/** Saves wait this long for more changes. */
export const SAVE_DEBOUNCE_MS = 2_000

export const keyOf = (sessionId: string) => `${KEY_PREFIX}${sessionId}`

export type Saved<T> = { savedAt: number; items: T[] }

/** What a stored item must expose to be pruned. */
export type Prunable = { phase: string; doneAt?: number; deploy?: { state: string } }

/** A store value read back, or undefined when it is not ours / malformed. */
export function readSaved<T>(value: unknown): Saved<T> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { savedAt?: unknown; items?: unknown }
  if (typeof v.savedAt !== 'number' || !Array.isArray(v.items)) return undefined
  return { savedAt: v.savedAt, items: v.items.filter(i => i && typeof i === 'object') as T[] }
}

/** Drops done items older than DONE_KEEP_MS (an active deploy offer expires with them). */
export function prune<T extends Prunable>(items: readonly T[], now: number): T[] {
  return items.filter(i => i.phase !== 'done' || (i.doneAt !== undefined && now - i.doneAt <= DONE_KEEP_MS))
}

/** The payload for `items`, dropping the oldest done items until it fits MAX_PAYLOAD. */
export function payloadOf<T extends Prunable>(items: readonly T[], now: number): Saved<T> {
  let kept = [...items]
  const size = () => JSON.stringify({ savedAt: now, items: kept }).length
  if (size() <= MAX_PAYLOAD) return { savedAt: now, items: kept }
  const done = kept.filter(i => i.phase === 'done').sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
  for (const d of done) {
    kept = kept.filter(i => i !== d)
    if (size() <= MAX_PAYLOAD) break
  }
  // Still too big (hundreds of live watches): keep the newest that fit.
  while (kept.length > 0 && size() > MAX_PAYLOAD) kept = kept.slice(1)
  return { savedAt: now, items: kept }
}

/** Whether a key belongs to another session and is stale enough to delete. */
export function isStaleForeign(key: string, ownKey: string, saved: Saved<unknown> | undefined, now: number): boolean {
  if (!key.startsWith(KEY_PREFIX) || key === ownKey) return false
  return !saved || now - saved.savedAt > FOREIGN_KEEP_MS
}
