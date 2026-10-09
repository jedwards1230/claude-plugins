/**
 * register.tsx's Host over a stand-in `$`: what the engine gets back from a
 * gh call that cannot start, the 15 s cap, and `~` in a parsed cwd.
 */
import { describe, expect, test } from 'claude-code/testing'

import { expandHome, hostOf } from '../hooks/register'

type Init = { cwd?: string; timeoutMs?: number }

/** Just the `$` nouns hostOf's `run` touches. */
function fake(run: (argv: readonly string[], init: Init) => Promise<unknown>, home: string | undefined = '/home/u') {
  const calls: { argv: readonly string[]; init: Init }[] = []
  const $ = {
    process: {
      run: (argv: readonly string[], init: Init) => {
        calls.push({ argv, init })
        return run(argv, init)
      },
    },
    env: { get: async (name: string) => (name === 'HOME' ? home : undefined) },
  }
  return { host: hostOf($ as never), calls }
}

const OK = { exitCode: 0, stdout: 'out', stderr: '' }

describe('hostOf', () => {
  test('a gh call that rejects (cannot start, timed out, denied) is null, never a throw', async () => {
    const { host } = fake(async () => {
      throw new Error('spawn gh ENOENT')
    })
    expect(await host.run(['gh', 'api', 'x'])).toBeNull()
    const denied = fake(() => Promise.reject({ deny: 'not allowed' }))
    expect(await denied.host.run(['gh', 'pr', 'view'], '/work')).toBeNull()
  })

  test('a reading of HOME that fails is null too', async () => {
    const $ = {
      process: { run: async () => OK },
      env: {
        get: async () => {
          throw new Error('no env')
        },
      },
    }
    expect(await hostOf($ as never).run(['gh'], '~/x')).toBeNull()
  })

  test('every call is capped at 15 s; the result is passed on', async () => {
    const { host, calls } = fake(async () => OK)
    expect(await host.run(['gh', 'api', 'x'])).toEqual(OK)
    await host.run(['gh', 'api', 'y'], '/abs/dir')
    expect(calls.map(c => c.init)).toEqual([{ timeoutMs: 15_000 }, { cwd: '/abs/dir', timeoutMs: 15_000 }])
  })

  test('a leading ~ in the cwd is the home directory', async () => {
    const { host, calls } = fake(async () => OK)
    for (const cwd of ['~/src/widget', '~', '~bob/x', '/abs/~/x']) await host.run(['gh'], cwd)
    expect(calls.map(c => c.init.cwd)).toEqual(['/home/u/src/widget', '/home/u', '~bob/x', '/abs/~/x'])
  })
})

describe('expandHome', () => {
  test('only ~ and ~/…; a trailing slash on HOME is not doubled; no HOME leaves it', () => {
    expect(expandHome('~/a', '/home/u/')).toBe('/home/u/a')
    expect(expandHome('~', '/home/u')).toBe('/home/u')
    expect(expandHome('~other', '/home/u')).toBe('~other')
    expect(expandHome('~/a', undefined)).toBe('~/a')
    expect(expandHome('rel/~', '/home/u')).toBe('rel/~')
  })
})
