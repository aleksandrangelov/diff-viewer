import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SNAPSHOT_REF = 'refs/diff-viewer/last-review'

export interface Repo {
  root: string
  gitDir: string
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')}: ${stderr.trim() || error.message}`))
        else resolvePromise(stdout)
      },
    )
  })
}

export async function findRepo(cwd: string): Promise<Repo | null> {
  try {
    const [root, gitDir] = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-dir'])).trim().split('\n')
    if (!root || !gitDir) return null
    return { root, gitDir: resolve(cwd, gitDir) }
  } catch {
    return null
  }
}

// Tree of the working directory as it is now, untracked files included, built in a throwaway index
// so the user's staging area is left untouched.
export async function worktreeTree(repo: Repo): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'dv-index-'))
  const index = join(tmp, 'index')
  try {
    await copyFile(join(repo.gitDir, 'index'), index).catch(() => {})
    const env = { GIT_INDEX_FILE: index }
    await git(repo.root, ['add', '-A', '--', '.'], env)
    return (await git(repo.root, ['write-tree'], env)).trim()
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export async function treeOf(repo: Repo, rev: string): Promise<string> {
  return (await git(repo.root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])).trim()
}

export async function headTree(repo: Repo): Promise<string> {
  return treeOf(repo, 'HEAD').catch(() => EMPTY_TREE)
}

export function diffTrees(repo: Repo, from: string, to: string): Promise<string> {
  return git(repo.root, [
    'diff', '--no-color', '--no-ext-diff', '-M', '-U3',
    '--src-prefix=a/', '--dst-prefix=b/', from, to,
  ])
}

// Pins a reviewed tree under a ref so `git gc` keeps it around for the "since last review" view.
export async function pinTree(repo: Repo, tree: string): Promise<void> {
  const env = {
    GIT_AUTHOR_NAME: 'diff-viewer', GIT_AUTHOR_EMAIL: 'diff-viewer@localhost',
    GIT_COMMITTER_NAME: 'diff-viewer', GIT_COMMITTER_EMAIL: 'diff-viewer@localhost',
  }
  const commit = (await git(repo.root, ['commit-tree', tree, '-m', 'diff-viewer review snapshot'], env)).trim()
  await git(repo.root, ['update-ref', SNAPSHOT_REF, commit])
}

export async function pinnedTree(repo: Repo): Promise<string | null> {
  return treeOf(repo, SNAPSHOT_REF).catch(() => null)
}
