/**
 * The value gh-monitor keeps in `$.state` for the session: the engine's
 * latest Snapshot, which the band and the pane read while drawing (a read
 * subscribes them; the subscriber in ../register.tsx writes it after every
 * engine change). Plain JSON, so a hot reload keeps it.
 *
 * Its contract is ../../types/index.d.ts (the manifest's `types`, which
 * `claude plugin validate` holds every `$.state` key to and which may import
 * nothing); its ref, `VIEW`, lives in ../register.tsx, since `$.state` takes
 * only a literal ref spelled in the hooks module. These two convert between
 * the engine's Snapshot and that JSON shape.
 */
import type { GhMonitorView } from '../../types'
import type { Snapshot } from '../engine/model'

export const EMPTY: Snapshot = { now: 0, items: [] }

/** The Snapshot as state holds it: JSON (undefined fields dropped, which state refuses). */
export function toView(snap: Snapshot): GhMonitorView {
  return JSON.parse(JSON.stringify(snap)) as GhMonitorView
}

/** What the band and pane draw from; written only by toView, so the items are the engine's. */
export function fromView(view: GhMonitorView | undefined): Snapshot {
  return view ? (view as unknown as Snapshot) : EMPTY
}
