import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/diff.js'
import { formatReviews } from '../src/format.js'
import type { Comment } from '../src/store.js'
import { buildRows, commentFromSelection } from '../src/tui/rows.js'

const [file] = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@
 keep
-old1
-old2
+new1
 tail
`)

const comment = (over: Partial<Comment>): Comment => ({
  id: 'c1', file: 'a.ts', side: 'new', start: 11, end: 11, snippet: ['+new1'], body: 'rename this', ...over,
})

describe('commentFromSelection', () => {
  const rows = buildRows(file!, [])
  // rows: 0 hunk, 1 keep, 2 -old1, 3 -old2, 4 +new1, 5 tail

  it('anchors a single added line to the new side', () => {
    expect(commentFromSelection(file!, rows, 4, 4)).toEqual({ file: 'a.ts', side: 'new', start: 11, end: 11, snippet: ['+new1'] })
  })

  it('anchors removed-only selections to the old side', () => {
    expect(commentFromSelection(file!, rows, 3, 2)).toMatchObject({ side: 'old', start: 11, end: 12, snippet: ['-old1', '-old2'] })
  })

  it('uses new-side numbers for mixed selections but quotes every line', () => {
    expect(commentFromSelection(file!, rows, 1, 5)).toMatchObject({
      side: 'new', start: 10, end: 12, snippet: [' keep', '-old1', '-old2', '+new1', ' tail'],
    })
  })

  it('returns null when only a hunk header is selected', () => {
    expect(commentFromSelection(file!, rows, 0, 0)).toBeNull()
  })
})

describe('buildRows', () => {
  it('places comments under their last line and lifts unmatched ones to the top as outdated', () => {
    const rows = buildRows(file!, [
      comment({}),
      comment({ id: 'c2', start: 11, end: 11, snippet: ['+deleted since'], body: 'gone\nsecond line' }),
      comment({ id: 'c3', side: 'file', start: 0, end: 0, snippet: [], body: 'whole file' }),
      comment({ id: 'c4', file: 'other.ts' }),
    ])
    expect(rows.map((r) => (r.kind === 'comment' ? `${r.comment.id}:${r.text}:${r.outdated}` : r.kind))).toEqual([
      'c3:whole file:false', 'c2:gone:true', 'c2:second line:true',
      'hunk', 'line', 'line', 'line', 'line', 'c1:rename this:false', 'line',
    ])
  })
})

describe('comment relocation', () => {
  it('follows quoted code when line numbers shift', () => {
    const rows = buildRows(file!, [
      comment({ id: 'moved', start: 40, end: 40, snippet: ['+new1'] }),
      comment({ id: 'old', side: 'old', start: 1, end: 1, snippet: ['-old2'] }),
    ])
    const at = (id: string) => rows.findIndex((r) => r.kind === 'comment' && r.comment.id === id)
    expect(rows[at('moved') - 1]).toMatchObject({ kind: 'line', line: { text: 'new1' } })
    expect(rows[at('old') - 1]).toMatchObject({ kind: 'line', line: { text: 'old2' } })
  })
})

describe('formatReviews', () => {
  it('renders locations, quoted code and the summary', () => {
    const text = formatReviews([{
      id: 'r1', createdAt: '', baseLabel: 'uncommitted changes vs HEAD', summary: 'Mostly good.',
      comments: [
        comment({}),
        comment({ id: 'c2', side: 'old', start: 11, end: 12, snippet: ['-old1', '-old2'], body: 'why remove?' }),
        comment({ id: 'c3', side: 'file', start: 0, end: 0, snippet: [], body: 'needs tests' }),
        comment({ id: 'c4', snippet: ['+const s = `x`'], body: 'ok' }),
      ],
    }])
    expect(text).toContain('left 4 comments')
    expect(text).toContain('Overall: Mostly good.')
    expect(text).toContain('### a.ts:11\n```diff\n+new1\n```\nrename this')
    expect(text).toContain('### a.ts (removed lines 11-12 of the previous version)')
    expect(text).toContain('### a.ts (whole file)\nneeds tests')
    expect(text).toContain('### a.ts:11\n```diff\n+const s = `x`\n```\nok')
    expect(text.startsWith('<code-review')).toBe(true)
  })
})
