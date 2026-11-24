import type { DiffLine, FileDiff } from '../diff.js'
import type { Comment } from '../store.js'

export type Row =
  | { kind: 'hunk'; text: string }
  | { kind: 'line'; line: DiffLine }
  | { kind: 'comment'; comment: Comment; text: string; first: boolean; outdated: boolean }
  | { kind: 'note'; text: string }

function anchorOf(line: DiffLine): string {
  return line.kind === 'del' ? `old:${line.oldNo}` : `new:${line.newNo}`
}

function commentRows(comment: Comment, outdated: boolean): Row[] {
  return comment.body.split('\n').map((text, i) => ({ kind: 'comment', comment, text, first: i === 0, outdated }))
}

// Files keep changing while Claude works, so a comment follows the code it quoted: it stays on its
// recorded line if that line still reads the same, otherwise moves to the nearest line that does.
export function buildRows(file: FileDiff, comments: Comment[]): Row[] {
  const lines = file.hunks.flatMap((h) => h.lines)
  const anchored = new Map<string, Comment[]>()
  for (const c of comments) {
    if (c.file !== file.path || c.side === 'file') continue
    const quoted = c.snippet.findLast((s) => (c.side === 'old' ? s[0] === '-' : s[0] !== '-'))?.slice(1)
    const candidates = lines.filter((l) => (c.side === 'old' ? l.kind === 'del' : l.kind !== 'del') && l.text === quoted)
    const numberOf = (l: DiffLine) => (c.side === 'old' ? l.oldNo! : l.newNo!)
    const best = candidates.sort((a, b) => Math.abs(numberOf(a) - c.end) - Math.abs(numberOf(b) - c.end))[0]
    const key = best ? anchorOf(best) : `missing:${c.id}`
    anchored.set(key, [...(anchored.get(key) ?? []), c])
  }

  const rows: Row[] = []
  for (const c of comments) if (c.file === file.path && c.side === 'file') rows.push(...commentRows(c, false))

  const lineRows: Row[] = []
  const placed = new Set<string>()
  for (const hunk of file.hunks) {
    lineRows.push({ kind: 'hunk', text: hunk.header })
    for (const line of hunk.lines) {
      lineRows.push({ kind: 'line', line })
      const key = anchorOf(line)
      for (const c of anchored.get(key) ?? []) {
        lineRows.push(...commentRows(c, false))
        placed.add(c.id)
      }
    }
  }

  for (const list of anchored.values()) {
    for (const c of list) if (!placed.has(c.id)) rows.push(...commentRows(c, true))
  }
  if (file.binary) rows.push({ kind: 'note', text: 'Binary file changed' })
  else if (file.hunks.length === 0) rows.push({ kind: 'note', text: 'No content changes (mode or empty file)' })
  return [...rows, ...lineRows]
}

export function commentFromSelection(
  file: FileDiff,
  rows: Row[],
  from: number,
  to: number,
): Omit<Comment, 'id' | 'body'> | null {
  const lines = rows
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .flatMap((r) => (r.kind === 'line' ? [r.line] : []))
  if (lines.length === 0) return null

  const current = lines.filter((l) => l.kind !== 'del')
  const side = current.length > 0 ? 'new' : 'old'
  const numbers = side === 'new' ? current.map((l) => l.newNo!) : lines.map((l) => l.oldNo!)
  return {
    file: file.path,
    side,
    start: Math.min(...numbers),
    end: Math.max(...numbers),
    snippet: lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`),
  }
}
