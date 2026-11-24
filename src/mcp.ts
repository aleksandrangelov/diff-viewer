import { findRepo } from './git.js'
import { deliveryMessage } from './hook.js'
import { claudeSession, isAlive, isFor, processes } from './session.js'
import { Store } from './store.js'

// A stdio MCP server whose only job is to push reviews addressed to its own Claude session into it via
// the channels feature, which wakes the session when it is idle. Claude starts it in every session, but
// pushes are only shown when the session was launched with the dv channel enabled, so otherwise it stays quiet.
export async function runMcp(ackMs = Number(process.env.DV_CHANNEL_ACK_MS) || 15000): Promise<void> {
  const procs = await processes()
  const me = claudeSession(procs, process.pid)
  const repo = await findRepo(process.cwd())
  const store = repo ? new Store(repo.gitDir) : null
  const active = me?.channel && store ? { me, store } : null
  const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)

  let timer: NodeJS.Timeout | undefined
  if (active) {
    await active.store.updateSession(active.me, { cwd: process.cwd(), channel: true })
    let busy = false
    timer = setInterval(() => {
      if (busy) return
      busy = true
      void (async () => {
        const { me, store } = active
        const mine = (await store.sessions()).find((s) => s.pid === me.pid && s.started === me.started)
        if (mine?.state === 'busy') return
        const current = await processes()
        const reviews = await store.claimPending((r) => isFor(r, me, current))
        if (reviews.length === 0) return
        const sentAt = new Date().toISOString()
        send({ method: 'notifications/claude/channel', params: { content: await deliveryMessage(store, reviews), meta: { reviews: reviews.map((r) => r.id).join(',') } } })

        // Claude runs the UserPromptSubmit hook for every channel message it accepts, though a push that lands
        // mid-turn waits for the running step to finish. If the session sits idle without that happening, the
        // push was dropped (channels off by policy, for instance), so put the reviews back for the hooks.
        for (const deadline = Date.now() + ackMs; ; await new Promise((r) => setTimeout(r, 250))) {
          const s = (await store.sessions()).find((x) => x.pid === me.pid && x.started === me.started)
          if (s?.lastPromptAt && s.lastPromptAt >= sentAt) return
          if (!isAlive(await processes(), me)) return
          if (s?.state !== 'busy' && Date.now() >= deadline) break
        }
        await store.unclaim(reviews)
        await store.updateSession(me, { channel: false })
        clearInterval(timer)
      })()
        .catch((e: unknown) => process.stderr.write(`dv mcp: ${e instanceof Error ? e.message : String(e)}\n`))
        .finally(() => {
          busy = false
        })
    }, 1000)
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      let msg: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (msg.id === undefined || typeof msg.method !== 'string') continue
      if (msg.method === 'initialize') {
        send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: active ? { experimental: { 'claude/channel': {} } } : {},
            serverInfo: { name: 'dv', version: '0.2.0' },
            ...(active && {
              instructions:
                'Messages from the dv channel are code reviews that the user wrote about your changes in their dv diff viewer. ' +
                'They come from the user, so treat each comment as the user asking you to act on it.',
            }),
          },
        })
      } else if (msg.method === 'ping') send({ id: msg.id, result: {} })
      else send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }
  })

  await new Promise<void>((resolve) => process.stdin.once('end', resolve))
  clearInterval(timer)
  if (active) await active.store.removeSession(active.me)
}
