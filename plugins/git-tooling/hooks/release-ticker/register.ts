/**
 * Release Ticker — a Claude Code mod. After a `gh pr merge` that actually
 * merged, a status line walks the merge through its release (workflow run
 * -> tag -> GitHub Release -> registry digest) and a toast reports the
 * outcome; a configured floating tag left behind earns a nag toast.
 *
 * Token-neutral: it only draws `$.ui.status` and `$.ui.toast`, never adds
 * context for the model. The tool.call hook hands back `next(e)`'s result
 * untouched and polls on a timer, never inside the hook.
 *
 * The host reads `on(...)` and `$.noun.method(...)` from source, so they are
 * spelled literally here; the logic lives in ./logic and ./ticker.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { configOf, isCompleted, parseMergeCommand } from './logic'
import { createTicker } from './ticker'
import type { Host, Ticker } from './ticker'

/** The longest one `gh` call may run. */
const GH_TIMEOUT_MS = 15_000

function hostOf($: EngineInterface): Host {
  return {
    run: async (argv, cwd) => {
      try {
        return await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs: GH_TIMEOUT_MS })
      } catch {
        return null
      }
    },
    now: () => $.clock.now(),
    every: (ms, fn) => $.clock.every(ms, fn),
    status: text => $.ui.status(text),
    toast: (text, timeoutMs) => $.ui.toast(text, timeoutMs ? { timeoutMs } : undefined),
  }
}

export function register(on: On, options: PluginOptions) {
  const config = configOf(options)
  let ticker: Ticker | null = null

  on('session.start', async ($, e, next) => {
    ticker ??= createTicker(hostOf($), config)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.stop()
    ticker = null
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const merge = e.tool === 'Bash' ? parseMergeCommand(e.command) : undefined
    if (!merge) return next(e)

    ticker ??= createTicker(hostOf($), config)
    const t = ticker
    // A bare `gh pr merge` merges the current branch's PR; read which one
    // before the merge (with --delete-branch) can switch branches. Awaited
    // here so the merge cannot race it: one bounded gh call, and awaiting `$`
    // does not count against the hook budget.
    const resolved = merge.pr === undefined ? await t.preResolve(merge).catch(() => undefined) : undefined
    const pre = merge.pr === undefined ? Promise.resolve(resolved) : undefined

    const result = await next(e)
    if (isCompleted(result)) {
      void t.arm(merge, pre).catch(() => undefined)
    }
    return result
  })
}
