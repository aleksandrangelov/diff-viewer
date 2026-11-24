export type LineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: LineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export type FileStatus = 'M' | 'A' | 'D' | 'R'

export interface FileDiff {
  path: string
  oldPath?: string
  status: FileStatus
  binary: boolean
  hunks: Hunk[]
  added: number
  removed: number
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  const bytes: number[] = []
  const body = path.slice(1, -1)
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch))
      continue
    }
    const next = body[++i]!
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function stripPrefix(path: string): string {
  const p = unquote(path.replace(/\t$/, ''))
  return p.replace(/^[ab]\//, '')
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  let hunk: Hunk | undefined
  let oldNo = 0
  let newNo = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length)
      // Without a rename both sides are the same path, so the header splits evenly: "a/<p> b/<p>".
      const half = (rest.length - 1) / 2
      const guess = Number.isInteger(half) ? stripPrefix(rest.slice(half + 1)) : rest
      file = { path: guess, status: 'M', binary: false, hunks: [], added: 0, removed: 0 }
      hunk = undefined
      files.push(file)
      continue
    }
    if (!file) continue

    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'A'
      else if (line.startsWith('deleted file mode')) file.status = 'D'
      else if (line.startsWith('rename from ')) {
        file.status = 'R'
        file.oldPath = unquote(line.slice('rename from '.length))
      } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length))
      else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        if (file.status !== 'R') file.path = stripPrefix(line.slice(4))
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4))
      else if (line.startsWith('Binary files ')) file.binary = true
    }

    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue

    const marker = line[0]
    const body = line.slice(1)
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: body, newNo: newNo++ })
      file.added++
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++ })
      file.removed++
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}
