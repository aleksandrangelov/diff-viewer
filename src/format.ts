import type { Review } from './store.js'

export function formatReviews(reviews: Review[]): string {
  const total = reviews.reduce((n, r) => n + r.comments.length, 0)
  const parts = [
    '<code-review source="dv">',
    `The user reviewed your changes in a diff viewer and left ${total} comment${total === 1 ? '' : 's'}. ` +
      'Address every comment: make the requested change, or explain why if you disagree. ' +
      'Line numbers refer to the files as they were when reviewed; the quoted lines show exactly what was commented on.',
  ]
  for (const review of reviews) {
    parts.push('', `Reviewed diff: ${review.baseLabel}`)
    if (review.summary.trim()) parts.push('', `Overall: ${review.summary.trim()}`)
    for (const c of review.comments) {
      const range = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`
      const location = c.side === 'file' ? `${c.file} (whole file)`
        : c.side === 'old' ? `${c.file} (removed lines ${range} of the previous version)`
        : `${c.file}:${range}`
      parts.push('', `### ${location}`)
      if (c.snippet.length > 0) {
        const longestRun = Math.max(2, ...c.snippet.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)))
        const ticks = '`'.repeat(longestRun + 1)
        parts.push(`${ticks}diff\n${c.snippet.join('\n')}\n${ticks}`)
      }
      parts.push(c.body.trim())
    }
  }
  parts.push('</code-review>')
  return parts.join('\n')
}
