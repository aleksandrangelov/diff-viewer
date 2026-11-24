import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepo } from './git.js'
import { runHook } from './hook.js'
import { addHooks, removeHooks, type Settings } from './install.js'

const USAGE = `dv: review your working-tree changes and send comments to Claude Code

Usage:
  dv                     review uncommitted changes (vs HEAD, untracked files included)
  dv --base <ref>        review changes since the merge-base with <ref> (e.g. main)
  dv --since-review, -s  review only what changed since your last submitted review
  dv install [--project] add the delivery hooks to ~/.claude/settings.json
                         (or .claude/settings.local.json in this repo with --project)
  dv uninstall [--project]
  dv hook stop|prompt    hook entry points used by Claude Code (reads hook JSON on stdin)
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === 'hook') {
    const event = rest[0]
    if (event !== 'stop' && event !== 'prompt') return 0
    const chunks: Buffer[] = []
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    const output = await runHook(event, Buffer.concat(chunks).toString('utf8'))
    if (output) process.stdout.write(output)
    return 0
  }

  if (command === 'install' || command === 'uninstall') {
    let path = join(homedir(), '.claude', 'settings.json')
    if (rest.includes('--project')) {
      const repo = await findRepo(process.cwd())
      if (!repo) throw new Error('--project needs to be run inside a git repository')
      path = join(repo.root, '.claude', 'settings.local.json')
    }

    let settings: Settings = {}
    let existed = true
    try {
      settings = JSON.parse(await readFile(path, 'utf8')) as Settings
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${path}: ${(e as Error).message}`)
      existed = false
    }

    const before = JSON.stringify(settings)
    const dv = `node "${fileURLToPath(import.meta.url)}"`
    if (command === 'uninstall') removeHooks(settings)
    else addHooks(settings, dv)
    if (JSON.stringify(settings) === before) {
      console.log(`${path} is already up to date.`)
      return 0
    }

    await mkdir(dirname(path), { recursive: true })
    if (existed) await copyFile(path, `${path}.bak`)
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
    if (command === 'uninstall') console.log(`Removed the dv hooks from ${path}.`)
    else console.log(`Added Stop and UserPromptSubmit hooks to ${path}:\n  ${dv} hook stop|prompt`)
    if (existed) console.log(`Previous version saved to ${path}.bak`)
    if (command === 'install') console.log('Restart running Claude Code sessions for them to pick it up.')
    return 0
  }

  if (command === 'help' || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }

  let baseRef: string | undefined
  let sinceReview = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base' || arg === '-b') baseRef = argv[++i]
    else if (arg?.startsWith('--base=')) baseRef = arg.slice('--base='.length)
    else if (arg === '--since-review' || arg === '-s') sinceReview = true
    else {
      process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`)
      return 2
    }
  }

  const repo = await findRepo(process.cwd())
  if (!repo) {
    process.stderr.write('dv: not inside a git repository\n')
    return 1
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('dv: needs an interactive terminal\n')
    return 1
  }
  const { run } = await import('./tui/app.js')
  await run({ repo, baseRef: baseRef || undefined, sinceReview })
  process.exit(0)
}

// exitCode rather than process.exit(): hook output goes to a pipe, and exiting early could cut it off.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`dv: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
