interface HookCommand {
  type: string
  command: string
  timeout?: number
}

interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
}

export type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> }

const HOOK_EVENTS = { Stop: 'stop', UserPromptSubmit: 'prompt' } as const

export function removeHooks(settings: Settings): void {
  for (const [event, sub] of Object.entries(HOOK_EVENTS)) {
    const groups = settings.hooks?.[event]
    if (!groups) continue
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !/(^|[\s/'"])(dv|cli\.js)['"]? hook /.test(h.command) || !h.command.trimEnd().endsWith(`hook ${sub}`)) }))
      .filter((g) => g.hooks.length > 0)
    if (kept.length > 0) settings.hooks![event] = kept
    else delete settings.hooks![event]
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks
}

export function addHooks(settings: Settings, dvCommand: string): void {
  removeHooks(settings)
  settings.hooks ??= {}
  for (const [event, sub] of Object.entries(HOOK_EVENTS)) {
    settings.hooks[event] = [
      ...(settings.hooks[event] ?? []),
      { hooks: [{ type: 'command', command: `${dvCommand} hook ${sub}`, timeout: 10 }] },
    ]
  }
}
