import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

  // Moves every pending review to delivered/ and returns them. The rename is the claim: if two hooks race,
  // only the one whose rename succeeds delivers a given review.
  async claimPending(): Promise<Review[]> {
    const names = (await readdir(this.path('pending')).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.json'))
      .sort()
    if (names.length === 0) return []
    await mkdir(this.path('delivered'), { recursive: true })
    const reviews: Review[] = []
    for (const name of names) {
      const target = this.path('delivered', name)
      try {
        await rename(this.path('pending', name), target)
        reviews.push(JSON.parse(await readFile(target, 'utf8')) as Review)
      } catch {
        continue
      }
    }
    return reviews
  }
}
