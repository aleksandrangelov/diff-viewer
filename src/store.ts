import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, SessionRef } from './session.js'

export interface Comment {
  id: string
  file: string
  // 'new' anchors to lines in the current file, 'old' to lines that were removed, 'file' to the file as a whole.
  side: 'new' | 'old' | 'file'
  start: number
  end: number
  snippet: string[]
  body: string
}

export interface Review {
  id: string
  createdAt: string
  baseLabel: string
  summary: string
  comments: Comment[]
  target?: SessionRef
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export class Store {
  readonly dir: string

  constructor(gitDir: string) {
    this.dir = join(gitDir, 'diff-viewer')
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts)
  }

  async loadDraft(): Promise<Comment[]> {
    try {
      return JSON.parse(await readFile(this.path('draft.json'), 'utf8')) as Comment[]
    } catch {
      return []
    }
  }

  async saveDraft(comments: Comment[]): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    if (comments.length === 0) await rm(this.path('draft.json'), { force: true })
    else await writeAtomic(this.path('draft.json'), JSON.stringify(comments, null, 2))
  }

  async submit(review: Review): Promise<void> {
    await mkdir(this.path('pending'), { recursive: true })
    await writeAtomic(this.path('pending', `${review.id}.json`), JSON.stringify(review, null, 2))
    await rm(this.path('draft.json'), { force: true })
  }

  async pendingCount(): Promise<number> {
    const names = await readdir(this.path('pending')).catch(() => [] as string[])
    return names.filter((n) => n.endsWith('.json')).length
  }

  // Moves the accepted pending reviews to delivered/ and returns them. The rename is the claim: if two
  // sessions race, only the one whose rename succeeds delivers a given review.
  async claimPending(accept: (review: Review) => boolean = () => true): Promise<Review[]> {
    const names = (await readdir(this.path('pending')).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.json'))
      .sort()
    if (names.length === 0) return []
    await mkdir(this.path('delivered'), { recursive: true })
    const reviews: Review[] = []
    for (const name of names) {
      const target = this.path('delivered', name)
      try {
        const review = JSON.parse(await readFile(this.path('pending', name), 'utf8')) as Review
        if (!accept(review)) continue
        await rename(this.path('pending', name), target)
        reviews.push(review)
      } catch {
        continue
      }
    }
    return reviews
  }

  async unclaim(reviews: Review[]): Promise<void> {
    for (const r of reviews) await rename(this.path('delivered', `${r.id}.json`), this.path('pending', `${r.id}.json`))
  }

  async updateSession(ref: SessionRef, patch: Partial<Session>): Promise<void> {
    await mkdir(this.path('sessions'), { recursive: true })
    const path = this.path('sessions', `${ref.pid}.json`)
    let current: Partial<Session> = {}
    try {
      current = JSON.parse(await readFile(path, 'utf8')) as Session
      if (current.started !== ref.started) current = {}
    } catch {}
    await writeAtomic(path, JSON.stringify({ ...current, ...patch, pid: ref.pid, started: ref.started, updatedAt: new Date().toISOString() }, null, 2))
  }

  async sessions(): Promise<Session[]> {
    const names = await readdir(this.path('sessions')).catch(() => [] as string[])
    const sessions: Session[] = []
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        sessions.push(JSON.parse(await readFile(this.path('sessions', name), 'utf8')) as Session)
      } catch {}
    }
    return sessions
  }

  async removeSession(ref: SessionRef): Promise<void> {
    await rm(this.path('sessions', `${ref.pid}.json`), { force: true })
  }
}
