/**
 * gh-monitor's state contract: the one `$.state` value it keeps, the
 * engine's latest snapshot, which the band and the pane read while drawing.
 *
 * Self-contained, as `claude plugin validate` requires of a contract (no
 * import): the items are the engine's `Item`s (hooks/engine/model.ts) as plain
 * JSON; hooks/ui/state.ts reads them back as that type.
 */
export type GhMonitorViewItem = { id: string; [field: string]: unknown }
export type GhMonitorView = { now: number; items: GhMonitorViewItem[] }

declare module 'claude-code' {
  interface PluginState {
    'gh-monitor': { view: GhMonitorView }
  }
}
