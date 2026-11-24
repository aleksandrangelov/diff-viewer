import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.js'
import { diffTrees, findRepo, headTree, pinnedTree, pinTree, worktreeTree, type Repo } from '../src/git.js'
import { runHook } from '../src/hook.js'
import { Store, type Review } from '../src/store.js'

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js')

let dir: string
let repo: Repo

const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

const review = (id: string, body = 'fix this'): Review => ({
  id, createdAt: '', baseLabel: 'uncommitted changes vs HEAD', summary: '',
  comments: [{ id: 'c', file: 'a.txt', side: 'new', start: 2, end: 2, snippet: ['+B'], body }],
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dv-test-'))
  sh('init', '-q')
  sh('config', 'user.email', 't@t')
  sh('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'a\nb\nc\n')
  sh('add', '.')
  sh('commit', '-qm', 'init')
  repo = (await findRepo(dir))!
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('git snapshots', () => {
  it('diffs tracked edits and untracked files without touching the index', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\nB\nc\n')
    writeFileSync(join(dir, 'new.txt'), 'fresh\n')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'x\n')
    const indexBefore = readFileSync(join(repo.gitDir, 'index'))

    const files = parseDiff(await diffTrees(repo, await headTree(repo), await worktreeTree(repo)))
    expect(files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A .gitignore', 'A new.txt', 'M a.txt'])
    expect(readFileSync(join(repo.gitDir, 'index'))).toEqual(indexBefore)
    expect(sh('status', '--porcelain')).toContain('?? new.txt')
  })

  it('pins a reviewed tree so later diffs show only newer changes', async () => {
    expect(await pinnedTree(repo)).toBeNull()
    writeFileSync(join(dir, 'a.txt'), 'a\nB\nc\n')
    await pinTree(repo, await worktreeTree(repo))
    writeFileSync(join(dir, 'a.txt'), 'a\nB\nC\n')

    const [file] = parseDiff(await diffTrees(repo, (await pinnedTree(repo))!, await worktreeTree(repo)))
    expect(file!.hunks[0]!.lines.filter((l) => l.kind !== 'ctx').map((l) => l.text)).toEqual(['c', 'C'])
  })

  it('works in a repository without commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dv-empty-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: empty })
      writeFileSync(join(empty, 'x.txt'), 'x\n')
      const r = (await findRepo(empty))!
      const files = parseDiff(await diffTrees(r, await headTree(r), await worktreeTree(r)))
      expect(files.map((f) => f.path)).toEqual(['x.txt'])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('hooks', () => {
  it('stop hook delivers each pending review exactly once', async () => {
    const store = new Store(repo.gitDir)
    await store.submit(review('r1'))
    await store.submit(review('r2', 'and this'))

    const out = JSON.parse((await runHook('stop', JSON.stringify({ cwd: dir, hook_event_name: 'Stop' })))!)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('fix this')
    expect(out.reason).toContain('and this')
    expect(out.reason).toContain('### a.txt:2')
    expect(await runHook('stop', JSON.stringify({ cwd: dir }))).toBeUndefined()
    expect(await store.pendingCount()).toBe(0)
  })

  it('prompt hook injects the review as additional context', async () => {
    await new Store(repo.gitDir).submit(review('r1'))
    const out = JSON.parse((await runHook('prompt', JSON.stringify({ cwd: dir, prompt: 'go' })))!)
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(out.hookSpecificOutput.additionalContext).toContain('fix this')
  })

  it('points Claude at a file when the review is too long to inline', async () => {
    const store = new Store(repo.gitDir)
    await store.submit(review('big', 'x'.repeat(20000)))
    const out = JSON.parse((await runHook('prompt', JSON.stringify({ cwd: dir })))!)
    const path = /at (\S+\.md)/.exec(out.hookSpecificOutput.additionalContext)![1]!
    expect(readFileSync(path, 'utf8')).toContain('x'.repeat(20000))
  })

  it('stays silent outside a git repo or with garbage input', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dv-norepo-'))
    try {
      expect(await runHook('stop', JSON.stringify({ cwd: outside }))).toBeUndefined()
      expect(await runHook('stop', 'not json')).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('built CLI reads hook JSON on stdin and exits 0', async () => {
    await new Store(repo.gitDir).submit(review('r1'))
    const run = (input: string) => spawnSync('node', [CLI, 'hook', 'stop'], { input, encoding: 'utf8', cwd: tmpdir() })
    const first = run(JSON.stringify({ cwd: dir, hook_event_name: 'Stop', stop_hook_active: false }))
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout).reason).toContain('fix this')
    const second = run(JSON.stringify({ cwd: dir }))
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')

    const body = 'He said "naïve — 日本語 ✓"\n'.repeat(330)
    await new Store(repo.gitDir).submit(review('r2', body))
    const big = spawnSync('node', [CLI, 'hook', 'prompt'], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8' })
    const context: string = JSON.parse(big.stdout).hookSpecificOutput.additionalContext
    expect(context.length).toBeGreaterThan(8000)
    expect(context).toContain(body.trim())
  })

  it('built CLI exits cleanly outside a repo', () => {
    const second = spawnSync('node', [CLI, 'hook', 'stop'], { input: '{}', encoding: 'utf8', cwd: tmpdir() })
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')
  })
})
