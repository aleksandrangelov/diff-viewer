import { describe, expect, it } from 'vitest'
import { addHooks, removeHooks, type Settings } from '../src/install.js'

const existing = (): Settings => ({
  theme: 'dark',
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'bash other.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }],
  },
})

describe('install', () => {
  it('adds both hooks and keeps unrelated settings and hooks', () => {
    const s = existing()
    addHooks(s, 'node "/opt/dv/dist/cli.js"')
    expect(s.theme).toBe('dark')
    expect(s.hooks!.SessionStart).toEqual(existing().hooks!.SessionStart)
    expect(s.hooks!.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'notify-done' }] },
      { hooks: [{ type: 'command', command: 'node "/opt/dv/dist/cli.js" hook stop', timeout: 10 }] },
    ])
    expect(s.hooks!.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'node "/opt/dv/dist/cli.js" hook prompt', timeout: 10 }] },
    ])
  })

  it('is idempotent and replaces hooks from an older install path', () => {
    const s = existing()
    addHooks(s, 'node "/old/cli.js"')
    addHooks(s, 'node "/new/cli.js"')
    const once = JSON.stringify(s)
    addHooks(s, 'node "/new/cli.js"')
    expect(JSON.stringify(s)).toBe(once)
    expect(JSON.stringify(s)).not.toContain('/old/')
  })

  it('uninstall restores the original settings', () => {
    const s = existing()
    addHooks(s, 'dv')
    removeHooks(s)
    expect(s).toEqual(existing())
  })
})
