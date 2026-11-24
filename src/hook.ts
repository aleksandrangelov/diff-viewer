import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatReviews } from './format.js'
import { findRepo } from './git.js'
import { claudeSession, isAlive, isFor, processes } from './session.js'
import { Store, type Review } from './store.js'

export type HookEvent = 'stop' | 'prompt'

// Claude Code caps hook context at 10,000 characters; past that, hand Claude a file to read instead.
const INLINE_LIMIT = 9000

export async function deliveryMessage(store: Store, reviews: Review[]): Promise<string> {
  const message = formatReviews(reviews)
  if (message.length <= INLINE_LIMIT) return message
  const file = join(store.dir, 'delivered', `${reviews.at(-1)!.id}.md`)
  await writeFile(file, message)
  return `The user submitted a code review that is too long to include inline. Read the full review at ${file} and address every comment in it.`
}

// Returns what the hook should print on stdout, or undefined to print nothing. Never throws:
// a broken review tool must not get in the way of the user's Claude session.
export async function runHook(event: HookEvent, stdin: string): Promise<string | undefined> {
  try {
    let input: { cwd?: unknown; prompt?: unknown; session_id?: unknown } = {}
    try {
      input = JSON.parse(stdin) as typeof input
    } catch {}
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()

    const repo = await findRepo(cwd)
    if (!repo) return undefined
    const store = new Store(repo.gitDir)
    const procs = await processes()
    const me = claudeSession(procs, process.pid)
    const reviews = await store.claimPending((r) => isFor(r, me, procs))
    if (me) {
      const now = new Date().toISOString()
      const prompt = typeof input.prompt === 'string' && !input.prompt.trimStart().startsWith('<') ? input.prompt.trim().slice(0, 200) : undefined
      await store.updateSession(me, {
        cwd,
        state: event === 'prompt' || reviews.length > 0 ? 'busy' : 'idle',
        ...(typeof input.session_id === 'string' && { sessionId: input.session_id }),
        ...(event === 'prompt' && { lastPromptAt: now }),
        ...(prompt && { prompt }),
      })
      for (const dead of (await store.sessions()).filter((s) => !isAlive(procs, s))) await store.removeSession(dead)
    }

    if (reviews.length === 0) return undefined
    const message = await deliveryMessage(store, reviews)
    if (event === 'stop') return JSON.stringify({ decision: 'block', reason: message })
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } })
  } catch (error) {
    process.stderr.write(`dv hook: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}
