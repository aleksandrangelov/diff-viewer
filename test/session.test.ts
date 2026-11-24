import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRepo, type Repo } from '../src/git.js'
import { runHook } from '../src/hook.js'
import { claudeSession, isFor, parseProcesses, processes, type SessionRef } from '../src/session.js'
import { Store, type Review } from '../src/store.js'

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js')

const PS = `
  100     1 Mon Nov 23 09:00:00 2026     -zsh
  200   100 Mon Nov 23 09:01:00 2026     claude --dangerously-load-development-channels server:dv
  210   200 Mon Nov 23 09:01:02 2026     node /Users/me/.volta/bin/dv mcp
  211   210 Tue Nov  3 09:01:02 2026     node /Users/me/dv/dist/cli.js mcp
  220   200 Mon Nov 23 09:05:00 2026     /bin/sh -c node "/Users/me/dv/dist/cli.js" hook stop
  221   220 Mon Nov 23 09:05:00 2026     node /Users/me/dv/dist/cli.js hook stop
  300   100 Mon Nov 23 09:02:00 2026     node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume
  310   300 Mon Nov 23 09:06:00 2026     node /Users/me/dv/dist/cli.js hook prompt
  400     1 Mon Nov 23 09:00:00 2026     node orphan.js
`

describe('session resolution', () => {
  const procs = parseProcesses(PS)

  it('finds the owning Claude process through shells and version-manager shims', () => {
    expect(procs.get(211)?.started).toBe('Tue Nov  3 09:01:02 2026')
    expect(claudeSession(procs, 211)).toEqual({ pid: 200, started: 'Mon Nov 23 09:01:00 2026', channel: true })
    expect(claudeSession(procs, 221)).toEqual(claudeSession(procs, 211))
    expect(claudeSession(procs, 310)).toEqual({ pid: 300, started: 'Mon Nov 23 09:02:00 2026', channel: false })
    expect(claudeSession(procs, 400)).toBeNull()
  })

  it('delivers a review to its target, or to anyone once the target is gone', () => {
    const a: SessionRef = { pid: 200, started: 'Mon Nov 23 09:01:00 2026' }
    const b: SessionRef = { pid: 300, started: 'Mon Nov 23 09:02:00 2026' }
    const review = (target?: SessionRef) => ({ target }) as Review
    expect(isFor(review(a), a, procs)).toBe(true)
    expect(isFor(review(a), b, procs)).toBe(false)
    expect(isFor(review(a), null, procs)).toBe(false)
    expect(isFor(review(), b, procs)).toBe(true)
    expect(isFor(review({ pid: 200, started: 'Sun Nov 22 08:00:00 2026' }), b, procs)).toBe(true)
  })
})

let dir: string
let repo: Repo
const review = (id: string, target?: SessionRef): Review => ({
  id, createdAt: '', baseLabel: 'uncommitted changes vs HEAD', summary: '', target,
  comments: [{ id: 'c', file: 'a.txt', side: 'new', start: 1, end: 1, snippet: ['+a'], body: `comment ${id}` }],
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dv-session-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  repo = (await findRepo(dir))!
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('targeted delivery', () => {
  it('hooks leave reviews addressed to another live session alone', async () => {
    const self = (await processes()).get(process.pid)!
    const store = new Store(repo.gitDir)
    await store.submit(review('mine-not', { pid: process.pid, started: self.started }))
    await store.submit(review('orphaned', { pid: 999999, started: 'Mon Nov 23 09:00:00 2026' }))
    const out = JSON.parse((await runHook('stop', JSON.stringify({ cwd: dir })))!)
    expect(out.reason).toContain('comment orphaned')
    expect(out.reason).not.toContain('comment mine-not')
    expect(await store.pendingCount()).toBe(1)
  })

  describe('channel server', () => {
    let fake: string
    beforeEach(() => {
      fake = mkdtempSync(join(tmpdir(), 'dv-fake-claude-'))
      writeFileSync(join(fake, 'claude'), `#!/bin/sh\nnode "${CLI}" mcp\nexit $?\n`)
      chmodSync(join(fake, 'claude'), 0o755)
    })
    afterEach(() => rmSync(fake, { recursive: true, force: true }))

    async function start(...flags: string[]) {
      const child = spawn(join(fake, 'claude'), flags, { cwd: dir, env: { ...process.env, DV_CHANNEL_ACK_MS: '1500' } })
      const messages: any[] = []
      const waiters: (() => void)[] = []
      createInterface({ input: child.stdout! }).on('line', (l) => {
        messages.push(JSON.parse(l))
        waiters.splice(0).forEach((w) => w())
      })
      const next = async (pred: (m: any) => boolean, ms = 8000) => {
        const end = Date.now() + ms
        for (;;) {
          const found = messages.find(pred)
          if (found) return found
          if (Date.now() > end) throw new Error('timed out waiting for message')
          await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100) })
        }
      }
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`)
      const init = await next((m) => m.id === 0)
      const started = (await processes()).get(child.pid!)!.started
      return { child, init, next, me: { pid: child.pid!, started } }
    }

    it('pushes its own session\'s review and keeps it delivered once Claude acknowledges it', async () => {
      const { child, init, next, me } = await start('--dangerously-load-development-channels', 'server:dv')
      try {
        expect(init.result.capabilities.experimental['claude/channel']).toEqual({})
        const store = new Store(repo.gitDir)
        await store.submit(review('r1', me))
        const push = await next((m) => m.method === 'notifications/claude/channel')
        expect(push.params.content).toContain('comment r1')
        await store.updateSession(me, { lastPromptAt: new Date().toISOString(), state: 'busy' })
        await new Promise((r) => setTimeout(r, 2000))
        expect(await store.pendingCount()).toBe(0)
      } finally {
        child.stdin!.end()
        child.kill()
      }
    })

    it('puts the review back for the hooks when Claude never acknowledges the push', async () => {
      const { child, next, me } = await start('--dangerously-load-development-channels', 'server:dv')
      try {
        const store = new Store(repo.gitDir)
        await store.submit(review('r1', me))
        await next((m) => m.method === 'notifications/claude/channel')
        await new Promise((r) => setTimeout(r, 2500))
        expect(await store.pendingCount()).toBe(1)
        expect((await store.sessions())[0]?.channel).toBe(false)
      } finally {
        child.stdin!.end()
        child.kill()
      }
    })

    it('keeps waiting for the acknowledgement while the session is busy', async () => {
      const { child, next, me } = await start('--dangerously-load-development-channels', 'server:dv')
      try {
        const store = new Store(repo.gitDir)
        await store.submit(review('r1', me))
        await next((m) => m.method === 'notifications/claude/channel')
        await store.updateSession(me, { state: 'busy' })
        await new Promise((r) => setTimeout(r, 2500))
        expect(await store.pendingCount()).toBe(0)
        expect((await store.sessions())[0]?.channel).toBe(true)
      } finally {
        child.stdin!.end()
        child.kill()
      }
    })

    it('marks the session busy when the Stop hook hands Claude a review', async () => {
      writeFileSync(join(fake, 'claude'), `#!/bin/sh\nnode "${CLI}" hook stop\nexit $?\n`)
      const store = new Store(repo.gitDir)
      const run = () => spawnSync(join(fake, 'claude'), [], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8' })
      expect(run().stdout).toBe('')
      expect((await store.sessions())[0]?.state).toBe('idle')
      await store.submit(review('r1'))
      expect(JSON.parse(run().stdout).decision).toBe('block')
      expect((await store.sessions())[0]?.state).toBe('busy')
    })

    it('stays inert in a session started without the channel flag', async () => {
      const { child, init, me } = await start('--resume')
      try {
        expect(init.result.capabilities).toEqual({})
        const store = new Store(repo.gitDir)
        await store.submit(review('r1', me))
        await new Promise((r) => setTimeout(r, 1500))
        expect(await store.pendingCount()).toBe(1)
        expect(await store.sessions()).toEqual([])
      } finally {
        child.stdin!.end()
        child.kill()
      }
    })

    it('removes its session record when Claude closes it', async () => {
      const { child } = await start('--dangerously-load-development-channels', 'server:dv')
      expect(JSON.parse(readFileSync(join(repo.gitDir, 'diff-viewer', 'sessions', `${child.pid}.json`), 'utf8')).channel).toBe(true)
      child.stdin!.end()
      await new Promise((r) => child.on('exit', r))
      expect(await new Store(repo.gitDir).sessions()).toEqual([])
    })
  })
})
