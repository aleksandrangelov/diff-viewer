import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatReviews } from './format.js'
import { findRepo } from './git.js'
import { Store } from './store.js'

export type HookEvent = 'stop' | 'prompt'

// Claude Code caps hook context at 10,000 characters; past that, hand Claude a file to read instead.
const INLINE_LIMIT = 9000

// Returns what the hook should print on stdout, or undefined to print nothing. Never throws:
// a broken review tool must not get in the way of the user's Claude session.
export async function runHook(event: HookEvent, stdin: string): Promise<string | undefined> {
  try {
    let cwd = process.cwd()
    try {
      const input = JSON.parse(stdin) as { cwd?: unknown }
      if (typeof input.cwd === 'string') cwd = input.cwd
    } catch {}

    const repo = await findRepo(cwd)
    if (!repo) return undefined
    const store = new Store(repo.gitDir)
    const reviews = await store.claimPending()
    if (reviews.length === 0) return undefined

    let message = formatReviews(reviews)
    if (message.length > INLINE_LIMIT) {
      const file = join(store.dir, 'delivered', `${reviews.at(-1)!.id}.md`)
      await writeFile(file, message)
      message =
        `The user submitted a code review that is too long to include inline. ` +
        `Read the full review at ${file} and address every comment in it.`
    }

    if (event === 'stop') return JSON.stringify({ decision: 'block', reason: message })
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } })
  } catch (error) {
    process.stderr.write(`dv hook: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}
