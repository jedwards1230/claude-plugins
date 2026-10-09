/**
 * gh-monitor's hooks module: one pipeline per PR — checks, review, merged
 * (any route), release, published, and an opt-in deploy-repo bump — drawn on
 * the status line, a band above the prompt, toasts and a /gh-monitor pane.
 *
 * The engine reads `on(...)` and `$.noun.method(...)` from source and follows
 * `$` only into functions of this file, so every `$` call is spelled here:
 * hostOf builds the engine's Host over `$`, and the render hooks hand the
 * `$`-free UI (./ui) an element table and action closures.
 *
 * Token-neutral by default: every tool.call hook returns `next(e)`'s result
 * untouched, and a prompt gets context only when the `nudge` option is on.
 * Polling runs on `$.clock` timers inside the engine, never in a hook. Render
 * hooks only read `$.state`; they never write it and never boot the engine.
 */
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { configOf } from './engine/config'
import type { Config } from './engine/config'
import { createEngine } from './engine/engine'
import type { Engine, Host } from './engine/engine'
import type { ItemId, MonitorEvent, Snapshot } from './engine/model'
import { band } from './ui/band'
import { pane } from './ui/pane'
import { fromView, toView } from './ui/state'
import { bandRows, paneBlocks, statusLine, toastsFor } from './ui/text'

/** The longest one `gh` call may run. */
const GH_TIMEOUT_MS = 15_000
const PANE_ID = 'gh-monitor'
const PANE_TITLE = 'GitHub'
/** The Snapshot the band and pane draw from (declared in ./ui/state); a literal ref, as `$.state` requires. */
const VIEW = { plugin: 'gh-monitor', key: 'view' } as const

const COMMANDS = {
  watchPr: {
    name: 'watch-pr',
    description: 'Watch a PR through checks, review, merge and release',
    argumentHint: '<N | owner/repo#N | URL>…',
    immediate: true,
  },
  watchRelease: {
    name: 'watch-release',
    description: "Watch a repo's release: workflow, tag, GitHub release, image / chart",
    argumentHint: '<owner/repo> [--pr N | --tag vX]',
    immediate: true,
  },
  monitor: {
    name: 'gh-monitor',
    description: 'Show every watched PR and release, or stop one',
    argumentHint: '[open | stop <id|all>]',
    immediate: true,
  },
} as const

/**
 * `~` and `~/x` as the home directory (a `cd ~/x && gh …` the engine parsed;
 * `$.process.run` has no shell to expand it). `~user` is left alone.
 */
export function expandHome(cwd: string, home: string | undefined): string {
  if (!home || !(cwd === '~' || cwd.startsWith('~/'))) return cwd
  return `${home.replace(/\/+$/, '')}${cwd.slice(1)}`
}

/**
 * The engine's Host: bounded processes (every gh call capped at 15 s; one
 * that cannot start or times out is `null`, never a throw), the clock, the
 * store, the session. Exported for its tests only.
 */
export function hostOf($: EngineInterface): Host {
  return {
    run: async (argv, cwd) => {
      try {
        const dir = cwd ? expandHome(cwd, await $.env.get('HOME')) : undefined
        const r = await $.process.run([...argv], { ...(dir ? { cwd: dir } : {}), timeoutMs: GH_TIMEOUT_MS })
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      } catch {
        return null
      }
    },
    now: () => $.clock.now(),
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value as never),
    storeDelete: key => $.store.delete(key),
    storeKeys: () => $.store.keys(),
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
  }
}

/** What the hooks share across dispatches; module state, so a hot reload starts it over. */
type Ctx = {
  config: Config
  toastConfig: { timeoutMs: number; releaseWorkflow: string }
  engine: Engine | null
  booted: Promise<Engine> | null
  lastStatus: string | undefined
}

async function registerCommands($: EngineInterface) {
  await $.command.register(COMMANDS.watchPr)
  await $.command.register(COMMANDS.watchRelease)
  await $.command.register(COMMANDS.monitor)
}

/** Paints one engine change: the state the band and pane read, the status line, the toasts. */
function paint($: EngineInterface, ctx: Ctx, snap: Snapshot, events: readonly MonitorEvent[]) {
  void $.state.set(VIEW, toView(snap)).catch(() => undefined)
  const status = statusLine(snap)
  if (status !== ctx.lastStatus) {
    ctx.lastStatus = status
    $.ui.status(status)
  }
  for (const t of toastsFor(events, ctx.toastConfig)) $.ui.toast(t.text, { timeoutMs: t.timeoutMs })
}

/** Builds the engine once, from whichever non-render hook runs first (a hot reload fires no session.start). */
function ensure($: EngineInterface, ctx: Ctx): Promise<Engine> {
  ctx.booted ??= (async () => {
    const e = createEngine(hostOf($), ctx.config)
    ctx.engine = e
    e.subscribe((snap, events) => paint($, ctx, snap, events))
    await registerCommands($).catch(() => undefined)
    await e.boot()
    return e
  })()
  return ctx.booted
}

/**
 * `[ bump ]`: drafts the deploy request in the prompt box, replacing an empty
 * box or appending to a draft; never sends. The text is the one the row showed.
 */
async function bump($: EngineInterface, ctx: Ctx, id: ItemId, text: string) {
  if (!text) return
  const e = await ensure($, ctx)
  const box = await $.prompt.read()
  const hasDraft = box.text.trim() !== ''
  const filled = await $.prompt.fill({ text: hasDraft ? `\n${text}` : text, mode: hasDraft ? 'append' : 'replace' })
  if (filled.isFilled) e.deployFilled(id)
}

async function dismiss($: EngineInterface, ctx: Ctx, id: ItemId) {
  ;(await ensure($, ctx)).deployDismissed(id)
}

async function stop($: EngineInterface, ctx: Ctx, id: ItemId | 'all') {
  ;(await ensure($, ctx)).stop(id)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

export function register(on: On, options: PluginOptions) {
  const config: Config = configOf(options)
  const ctx: Ctx = {
    config,
    toastConfig: { timeoutMs: config.timeoutMs, releaseWorkflow: config.releaseWorkflow },
    engine: null,
    booted: null,
    lastStatus: undefined,
  }

  on('session.start', async ($, e, next) => {
    void ensure($, ctx).catch(() => undefined)
    await registerCommands($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear ends the conversation, not the work: keep watching under the new session.
    if (e.reason !== 'clear') {
      ctx.engine?.shutdown()
      ctx.engine = null
      ctx.booted = null
      ctx.lastStatus = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as { command?: string }).command
    try {
      const eng = await ensure($, ctx)
      await eng.beforeTool({ tool: 'Bash', command })
    } catch {
      // arming is best effort; the call itself must never be held up by it
    }
    const result = await next(e)
    try {
      ctx.engine?.afterTool({ tool: 'Bash', command, result })
    } catch {
      // never let arming touch the result
    }
    return result
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    void ensure($, ctx).catch(() => undefined)
    const command = (e as { command?: string }).command
    const result = await next(e)
    try {
      ctx.engine?.afterTool({ tool: 'Monitor', command, result })
    } catch {
      // never let arming touch the result
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const eng = await ensure($, ctx).catch(() => null)
    const kind = e.origin.kind
    eng?.onPrompt(e.text, kind)
    if (config.nudge && eng && (kind === 'composer' || kind === 'bridge')) {
      const lines = eng.takeNudges()
      if (lines.length > 0) return next({ ...e, context: [...(e.context ?? []), lines.join('\n')] })
    }
    return next(e)
  })

  on('command.run', { command: 'watch-pr' }, async ($, e) => ({ text: await (await ensure($, ctx)).watchPr(e.args) }))

  on('command.run', { command: 'watch-release' }, async ($, e) => ({
    text: await (await ensure($, ctx)).watchRelease(e.args),
  }))

  on('command.run', { command: 'gh-monitor' }, async ($, e) => {
    const eng = await ensure($, ctx)
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === '' || verb === 'open') {
      await openPane($)
      return { text: 'opened' }
    }
    if (verb === 'stop') {
      if (!arg) return { text: 'usage: /gh-monitor stop <id|all>' }
      const known = arg === 'all' || eng.snapshot().items.some(i => i.id === arg)
      if (!known) return { text: `not watching: ${arg}` }
      eng.stop(arg)
      return { text: arg === 'all' ? 'stopped all' : `stopped ${arg}` }
    }
    return { text: 'usage: /gh-monitor [open | stop <id|all>]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value } = await $.state.get(VIEW)
    const rows = bandRows(fromView(value), e.props.bodyColumns, e.props.maxRows)
    if (rows.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return band(rows, { Box, Text, Button }, { bump: (id, prompt) => void bump($, ctx, id, prompt).catch(() => undefined), dismiss: id => void dismiss($, ctx, id).catch(() => undefined) })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { value } = await $.state.get(VIEW)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    return pane(
      paneBlocks(fromView(value), e.props.bodyColumns),
      { Box, Text, Button, Link },
      {
        stop: id => void stop($, ctx, id).catch(() => undefined),
        bump: (id, prompt) => void bump($, ctx, id, prompt).catch(() => undefined),
        dismiss: id => void dismiss($, ctx, id).catch(() => undefined),
      },
    )
  })
}
