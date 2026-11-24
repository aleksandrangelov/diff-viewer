import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { Review } from './store.js'

export interface SessionRef {
  pid: number
  started: string
}

export interface Session extends SessionRef {
  channel?: boolean
  cwd?: string
  sessionId?: string
  state?: 'busy' | 'idle'
  prompt?: string
  lastPromptAt?: string
  updatedAt: string
}

export interface Proc {
  pid: number
  ppid: number
  started: string
  args: string
}

export function parseProcesses(text: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+ \S+ +\d+ [\d:]+ \d+)\s+(.*)$/.exec(line)
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), started: m[3]!, args: m[4]! })
  }
  return procs
}

export async function processes(): Promise<Map<number, Proc>> {
  const { stdout } = await promisify(execFile)('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args='], {
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseProcesses(stdout)
}

// Hooks and the channel server are both descendants of the Claude Code process that owns the session,
// usually through a shell or a node version-manager shim, so the nearest Claude ancestor identifies it.
export function claudeSession(procs: Map<number, Proc>, pid: number): (SessionRef & { channel: boolean }) | null {
  const seen = new Set<number>()
  for (let p = procs.get(pid); p && !seen.has(p.pid); p = procs.get(p.ppid)) {
    seen.add(p.pid)
    const [exe = '', script = ''] = p.args.split(/\s+/)
    if (basename(exe) === 'claude' || basename(script) === 'claude' || script.endsWith('claude-code/cli.js')) {
      return { pid: p.pid, started: p.started, channel: /--(dangerously-load-development-)?channels\b.*\bserver:dv\b/.test(p.args) }
    }
  }
  return null
}

export function isAlive(procs: Map<number, Proc>, ref: SessionRef): boolean {
  return procs.get(ref.pid)?.started === ref.started
}

export function isFor(review: Review, me: SessionRef | null, procs: Map<number, Proc>): boolean {
  const { target } = review
  if (!target || !isAlive(procs, target)) return true
  return me !== null && target.pid === me.pid && target.started === me.started
}
