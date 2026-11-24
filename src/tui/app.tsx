import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import stringWidth from 'string-width'
import { parseDiff, type FileDiff } from '../diff.js'
import { diffTrees, git, headTree, pinnedTree, pinTree, treeOf, worktreeTree, type Repo } from '../git.js'
import { isAlive, processes, type Session } from '../session.js'
import { newId, Store, type Comment } from '../store.js'
import { highlightFile, type Highlights, type Segment } from './highlight.js'
import { buildRows, commentFromSelection } from './rows.js'

export interface Options {
  repo: Repo
  baseRef?: string
  sinceReview: boolean
  pollMs?: number
}

interface Snapshot {
  files: FileDiff[]
  head: string
  base: string
  label: string
}

type Input =
  | { purpose: 'comment'; text: string; target: Omit<Comment, 'id' | 'body'> }
  | { purpose: 'edit'; text: string; id: string }
  | { purpose: 'summary'; text: string }

const GUTTER = 12
const COLORS = {
  addBg: '#12301f', delBg: '#3b1519', cursorBg: '#2f3f5f', selectBg: '#253350', headerBg: '#161b22',
  add: '#56d364', del: '#f85149', dim: '#6e7681', hunk: '#58a6ff', comment: '#e3b341', text: '#c9d1d9',
}
const STATUS_COLOR = { A: COLORS.add, D: COLORS.del, M: COLORS.comment, R: COLORS.hunk }

const HELP: [string, string][] = [
  ['j / k, ↓ / ↑', 'move'], ['ctrl-d / ctrl-u', 'half page down / up'], ['g / G', 'top / bottom'],
  ['{ / }', 'previous / next hunk'], ['n / p, ] / [', 'next / previous file'], ['tab', 'switch focus to file list'],
  ['v', 'start / cancel a range selection'], ['c, enter', 'comment on line or selection (edit if on a comment)'],
  ['C', 'comment on the whole file'], ['e', 'edit comment under cursor'], ['d', 'delete comment under cursor'],
  ['u', 'undo delete'], ['S', 'submit review to Claude'], ['s', 'toggle: all changes / since last review'],
  ['r', 'refresh now'], ['q', 'quit (draft comments are kept)'],
  ['', ''], ['while typing', 'enter saves · alt-enter newline · ctrl-e opens $EDITOR · esc cancels'],
]

const graphemes = new Intl.Segmenter()

// Cuts segments to exactly `width` terminal cells: wide characters count double, control characters are
// shown as visible symbols so file content can't drive the terminal, and the rest is padded with spaces.
function fit(segments: Segment[], width: number): Segment[] {
  const clean = segments.map((s) => ({
    ...s,
    text: s.text
      .replace(/\t/g, '    ')
      .replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\x7f' ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0)))),
  }))
  const total = clean.reduce((n, s) => n + stringWidth(s.text), 0)
  const limit = total > width ? width - 1 : width
  const out: Segment[] = []
  let used = 0
  let full = false
  for (const seg of clean) {
    let text = ''
    for (const { segment } of graphemes.segment(seg.text)) {
      const w = stringWidth(segment)
      if (used + w > limit) {
        full = true
        break
      }
      text += segment
      used += w
    }
    out.push({ ...seg, text })
    if (full) break
  }
  if (total > width && width > 0) {
    out.push({ text: '…' })
    used++
  }
  if (used < width) out.push({ text: ' '.repeat(width - used) })
  return out
}

const fitText = (text: string, width: number) => fit([{ text }], width).map((s) => s.text).join('')

function App({ repo, baseRef, sinceReview: initialSince, pollMs = 1500 }: Options) {
  const { exit, suspendTerminal } = useApp()
  const { columns, rows: termRows } = useWindowSize()
  const store = useMemo(() => new Store(repo.gitDir), [repo])

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [fileIdx, setFileIdx] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [since, setSince] = useState(initialSince)
  const [focus, setFocus] = useState<'files' | 'diff'>('diff')
  const [input, setInput] = useState<Input | null>(null)
  const [help, setHelp] = useState(false)
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState(0)
  const [deleted, setDeleted] = useState<Comment | null>(null)
  const [highlights, setHighlights] = useState<{ file: FileDiff; map: Highlights } | null>(null)
  const [targets, setTargets] = useState<Session[]>([])
  const [targetIdx, setTargetIdx] = useState(0)

  const snapRef = useRef<Snapshot | null>(null)
  const loading = useRef(false)
  const scrollRef = useRef(0)
  const currentPath = useRef<string | undefined>(undefined)
  const highlightCache = useRef(new WeakMap<FileDiff, Highlights>())

  const fail = (e: unknown) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)

  async function load(force: boolean, sinceReview = since) {
    if (loading.current) return
    loading.current = true
    try {
      const head = await worktreeTree(repo)
      let base: string
      let label: string
      if (sinceReview) {
        const pinned = await pinnedTree(repo)
        if (!pinned) {
          setStatus('No review submitted yet, so showing all changes')
          setSince(false)
          loading.current = false
          return load(true, false)
        }
        base = pinned
        label = 'changes since your last review'
      } else if (baseRef) {
        base = await treeOf(repo, (await git(repo.root, ['merge-base', baseRef, 'HEAD'])).trim())
        label = `changes vs ${baseRef}`
      } else {
        base = await headTree(repo)
        label = 'uncommitted changes vs HEAD'
      }
      setPending(await store.pendingCount())
      const prev = snapRef.current
      if (!force && prev && prev.head === head && prev.base === base) return

      const next = { files: parseDiff(await diffTrees(repo, base, head)), head, base, label }
      const keep = next.files.findIndex((f) => f.path === currentPath.current)
      snapRef.current = next
      setSnap(next)
      if (keep >= 0) setFileIdx(keep)
      else {
        setFileIdx(0)
        setCursor(0)
        setAnchor(null)
      }
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loading.current = false
    }
  }

  useEffect(() => {
    store.loadDraft().then(setComments, fail)
  }, [store])

  useEffect(() => {
    void load(true)
    const timer = setInterval(() => void load(false), pollMs)
    return () => clearInterval(timer)
  }, [since])

  useEffect(() => {
    if (comments) store.saveDraft(comments).catch(fail)
  }, [comments, store])

  const files = snap?.files ?? []
  const file = files[Math.min(fileIdx, files.length - 1)]
  const rows = useMemo(() => (file ? buildRows(file, comments ?? []) : []), [file, comments])
  currentPath.current = file?.path

  useEffect(() => {
    if (!file) return
    const cached = highlightCache.current.get(file)
    if (cached) return setHighlights({ file, map: cached })
    let cancelled = false
    highlightFile(file)
      .then((map) => {
        highlightCache.current.set(file, map)
        if (!cancelled) setHighlights({ file, map })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [file])

  const showList = columns >= 90
  const listWidth = showList ? Math.min(44, Math.floor(columns * 0.28)) : 0
  const diffWidth = columns - listWidth - (showList ? 1 : 0)
  const inputHeight = input ? Math.min(6, input.text.split('\n').length) + (input.purpose === 'summary' ? 4 : 3) : 0
  const bodyHeight = Math.max(3, termRows - 2 - inputHeight)
  const cur = Math.max(0, Math.min(cursor, rows.length - 1))

  let scroll = scrollRef.current
  if (cur < scroll) scroll = cur
  if (cur >= scroll + bodyHeight) scroll = cur - bodyHeight + 1
  scroll = Math.max(0, Math.min(scroll, rows.length - bodyHeight))
  scrollRef.current = scroll

  function selectFile(i: number) {
    if (files.length === 0) return
    setFileIdx((i + files.length) % files.length)
    setCursor(0)
    setAnchor(null)
    scrollRef.current = 0
  }

  useInput(
    (ch, key) => {
      if (!input) return
      if (key.escape) return setInput(null)
      if (key.ctrl && ch === 'u') return setInput({ ...input, text: '' })
      if (key.ctrl && ch === 'w') return setInput({ ...input, text: input.text.replace(/\S*\s*$/, '') })
      if (key.backspace || key.delete) return setInput({ ...input, text: input.text.slice(0, -1) })
      if ((key.return && key.meta) || (key.ctrl && ch === 'j')) return setInput({ ...input, text: input.text + '\n' })
      if (key.tab && input.purpose === 'summary') return setTargetIdx((i) => (targets.length ? (i + 1) % targets.length : 0))

      if (key.ctrl && ch === 'e') {
        void (async () => {
          const dir = await mkdtemp(join(tmpdir(), 'dv-comment-'))
          const path = join(dir, 'COMMENT.md')
          try {
            await writeFile(path, input.text)
            const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
            await suspendTerminal(() => {
              spawnSync(`${editor} "${path}"`, { stdio: 'inherit', shell: true })
            })
            setInput({ ...input, text: (await readFile(path, 'utf8')).replace(/\s+$/, '') })
          } finally {
            await rm(dir, { recursive: true, force: true })
          }
        })().catch(fail)
        return
      }

      if (key.return) {
        const text = input.text.replace(/\s+$/, '')
        setInput(null)
        if (input.purpose === 'summary') {
          const list = comments ?? []
          if (list.length === 0 && !text) return setStatus('Nothing to submit: add a comment or a summary')
          if (!snap) return
          const target = targets[targetIdx]
          void (async () => {
            await store.submit({
              id: newId(), createdAt: new Date().toISOString(), baseLabel: snap.label, summary: text, comments: list,
              ...(target && { target: { pid: target.pid, started: target.started } }),
            })
            setComments([])
            setPending(await store.pendingCount())
            setStatus(!target ? 'Review queued. The next Claude session here to finish a turn or get a prompt picks it up.'
              : target.channel && target.state !== 'busy' ? 'Review sent. Claude is picking it up now.'
              : target.channel ? 'Review queued. Claude gets it when its current turn ends.'
              : 'Review queued. Claude gets it when its current turn ends, or with your next prompt.')
            await pinTree(repo, snap.head)
          })().catch(fail)
          return
        }
        if (!text) return
        if (input.purpose === 'edit') return setComments((cs) => (cs ?? []).map((c) => (c.id === input.id ? { ...c, body: text } : c)))
        setComments((cs) => [...(cs ?? []), { ...input.target, id: newId(), body: text }])
        return setAnchor(null)
      }

      if (ch && !key.ctrl && !key.meta) setInput({ ...input, text: input.text + ch.replace(/\r\n?/g, '\n') })
    },
    { isActive: input !== null },
  )

  useInput(
    (ch, key) => {
      setStatus('')
      if (help) return setHelp(false)
      if (ch === 'q' || (key.ctrl && ch === 'c')) return exit()
      if (ch === '?') return setHelp(true)
      if (ch === 'r') return void load(true)
      if (ch === 's') {
        setSince(!since)
        snapRef.current = null
        return
      }
      if (ch === 'S') {
        setInput({ purpose: 'summary', text: '' })
        void Promise.all([store.sessions(), processes()]).then(([sessions, procs]) => {
          for (const dead of sessions.filter((x) => !isAlive(procs, x))) void store.removeSession(dead)
          setTargets(sessions.filter((x) => isAlive(procs, x)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
          setTargetIdx(0)
        }, fail)
        return
      }
      if (key.tab) return setFocus(focus === 'files' ? 'diff' : 'files')
      if (ch === 'n' || ch === ']') return selectFile(fileIdx + 1)
      if (ch === 'p' || ch === '[') return selectFile(fileIdx - 1)

      if (focus === 'files') {
        if (ch === 'j' || key.downArrow) return selectFile(fileIdx + 1)
        if (ch === 'k' || key.upArrow) return selectFile(fileIdx - 1)
        if (key.return || ch === 'l' || key.rightArrow || key.escape) return setFocus('diff')
        return
      }

      const half = Math.max(1, Math.floor(bodyHeight / 2))
      const last = rows.length - 1
      if (ch === 'j' || key.downArrow) return setCursor(Math.min(last, cur + 1))
      if (ch === 'k' || key.upArrow) return setCursor(Math.max(0, cur - 1))
      if ((key.ctrl && ch === 'd') || key.pageDown) return setCursor(Math.min(last, cur + half))
      if ((key.ctrl && ch === 'u') || key.pageUp) return setCursor(Math.max(0, cur - half))
      if (ch === 'g' || key.home) return setCursor(0)
      if (ch === 'G' || key.end) return setCursor(last)
      if (ch === '}' || ch === '{') {
        const step = ch === '}' ? 1 : -1
        for (let i = cur + step; i >= 0 && i <= last; i += step) if (rows[i]?.kind === 'hunk') return setCursor(i)
        return
      }
      if (key.escape) return setAnchor(null)
      if (ch === 'v') return setAnchor(anchor === null ? cur : null)
      if (ch === 'u') {
        if (!deleted) return setStatus('Nothing to undo')
        setComments((cs) => [...(cs ?? []), deleted])
        return setDeleted(null)
      }
      if (!file) return

      const row = rows[cur]
      const onComment = row?.kind === 'comment' ? row.comment : undefined
      if (ch === 'd' && onComment) {
        setComments((cs) => (cs ?? []).filter((c) => c.id !== onComment.id))
        setDeleted(onComment)
        return setStatus('Comment deleted (u to undo)')
      }
      if ((ch === 'e' || ch === 'c' || key.return) && onComment) {
        return setInput({ purpose: 'edit', text: onComment.body, id: onComment.id })
      }
      if (ch === 'C') {
        return setInput({ purpose: 'comment', text: '', target: { file: file.path, side: 'file', start: 0, end: 0, snippet: [] } })
      }
      if (ch === 'c' || key.return) {
        const target = commentFromSelection(file, rows, anchor ?? cur, cur)
        if (!target) return setStatus('Move to a diff line to comment on it (or C for the whole file)')
        return setInput({ purpose: 'comment', text: '', target })
      }
    },
    { isActive: input === null },
  )

  const commentCount = comments?.length ?? 0
  const right = `${commentCount} draft comment${commentCount === 1 ? '' : 's'}${pending ? ` · ${pending} awaiting Claude` : ''} `
  const position = file ? ` · ${fileIdx + 1}/${files.length} ${file.path}` : ''
  const left = ` dv · ${snap?.label ?? 'loading…'}${position}`
  const selection = anchor === null ? null : ([Math.min(anchor, cur), Math.max(anchor, cur)] as const)

  const hints = anchor !== null
    ? 'selecting · c comment on selection · esc cancel'
    : 'j/k move · n/p file · v select · c comment · S submit · s since-review · ? help · q quit'

  let body: ReactNode
  if (help) {
    body = (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Keys</Text>
        {HELP.map(([k, d], i) => <Text key={i}><Text color={COLORS.hunk}>{k.padEnd(18)}</Text>{d}</Text>)}
        <Text color={COLORS.dim}>{'\n'}Press any key to close.</Text>
      </Box>
    )
  } else if (error) {
    body = <Text color={COLORS.del}>{error}</Text>
  } else if (!snap) {
    body = <Text color={COLORS.dim}> Loading…</Text>
  } else if (files.length === 0) {
    body = <Text color={COLORS.dim}>{` No ${snap.label}. Watching for changes…`}</Text>
  } else {
    const fileHighlights = highlights && highlights.file === file ? highlights.map : undefined
    body = (
      <Box flexDirection="row">
        {showList && (
          <Box flexDirection="column" width={listWidth} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false}
            borderColor={focus === 'files' ? COLORS.hunk : COLORS.dim}>
            {files.slice(Math.max(0, Math.min(fileIdx - Math.floor(bodyHeight / 2), files.length - bodyHeight)))
              .slice(0, bodyHeight)
              .map((f) => {
                const n = (comments ?? []).filter((c) => c.file === f.path).length
                const tail = `${n ? ` ●${n}` : ''} +${f.added} -${f.removed}`
                const room = listWidth - 3 - tail.length
                const name = f.path.length > room ? `…${f.path.slice(f.path.length - room + 1)}` : f.path
                const active = f === file
                return (
                  <Text key={f.path} inverse={active && focus === 'files'} bold={active}>
                    <Text color={STATUS_COLOR[f.status]}>{f.status} </Text>
                    <Text color={active ? COLORS.text : COLORS.dim}>{fitText(name, room)}</Text>
                    <Text color={n ? COLORS.comment : COLORS.dim}>{tail}</Text>
                  </Text>
                )
              })}
          </Box>
        )}
        <Box flexDirection="column" width={diffWidth}>
          {rows.slice(scroll, scroll + bodyHeight).map((row, i) => {
            const index = scroll + i
            const isCursor = focus === 'diff' && index === cur
            if (row.kind === 'hunk') {
              return <Text key={index} color={COLORS.hunk} backgroundColor={isCursor ? COLORS.cursorBg : undefined}>{fitText(row.text, diffWidth)}</Text>
            }
            if (row.kind === 'note') return <Text key={index} color={COLORS.dim} italic>{fitText(`  ${row.text}`, diffWidth)}</Text>
            if (row.kind === 'comment') {
              const c = row.comment
              const where = c.side === 'file' ? 'file' : `${c.side === 'old' ? 'removed ' : ''}L${c.start}${c.end !== c.start ? `-${c.end}` : ''}`
              const label = row.first ? (row.outdated ? `[not in this diff · ${where}] ` : c.side === 'file' ? '[file] ' : '') : ''
              return (
                <Text key={index} backgroundColor={isCursor ? COLORS.cursorBg : undefined}>
                  <Text color={COLORS.comment}>{'            ▍ '}</Text>
                  <Text color={COLORS.comment} bold>{fitText(label + row.text, diffWidth - 14)}</Text>
                </Text>
              )
            }
            const { line } = row
            const selected = selection !== null && index >= selection[0] && index <= selection[1]
            const bg = isCursor ? COLORS.cursorBg : selected ? COLORS.selectBg : line.kind === 'add' ? COLORS.addBg : line.kind === 'del' ? COLORS.delBg : undefined
            const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
            const segments = fit(fileHighlights?.get(line) ?? [{ text: line.text }], diffWidth - GUTTER)
            return (
              <Text key={index} backgroundColor={bg}>
                <Text color={COLORS.dim}>{`${String(line.oldNo ?? '').padStart(4)} ${String(line.newNo ?? '').padStart(4)} `}</Text>
                <Text color={line.kind === 'add' ? COLORS.add : line.kind === 'del' ? COLORS.del : COLORS.dim}>{`${marker} `}</Text>
                {segments.map((s, j) => <Text key={j} color={s.color ?? COLORS.text}>{s.text}</Text>)}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  }

  const where = input?.purpose === 'comment'
    ? input.target.side === 'file' ? input.target.file : `${input.target.file}:${input.target.start}${input.target.end !== input.target.start ? `-${input.target.end}` : ''}`
    : ''
  const inputTitle = input?.purpose === 'summary'
    ? `Submit review (${commentCount} comment${commentCount === 1 ? '' : 's'}): optional overall note, enter to send`
    : input?.purpose === 'edit' ? 'Edit comment' : `Comment on ${where}`
  const target = targets[targetIdx]
  const targetLine = !target
    ? 'No Claude session seen in this repo yet: the next one to finish a turn or get a prompt picks it up'
    : [
        `→ ${target.prompt ? `"${fitText(target.prompt.replace(/\s+/g, ' '), Math.min(48, stringWidth(target.prompt.replace(/\s+/g, ' ')))).trimEnd()}"` : `session ${target.pid}`}`,
        target.channel ? target.state ?? 'idle' : 'no channel',
        `${Math.max(0, Math.round((Date.now() - Date.parse(target.updatedAt)) / 60000))}m ago`,
        ...(targets.length > 1 ? [`tab: next session (${targetIdx + 1}/${targets.length})`] : []),
      ].join(' · ')

  return (
    <Box flexDirection="column" width={columns} height={termRows}>
      <Text backgroundColor={COLORS.headerBg} bold>
        {fitText(left, Math.max(0, columns - stringWidth(right) - 1))}{' '}
        <Text color={COLORS.comment}>{right}</Text>
      </Text>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">{body}</Box>
      {input && (
        <Box flexDirection="column" borderStyle="round" borderColor={COLORS.comment} paddingX={1}>
          <Text color={COLORS.comment}>{inputTitle}</Text>
          {input.purpose === 'summary' && <Text color={COLORS.hunk}>{fitText(targetLine, columns - 4)}</Text>}
          {input.text.split('\n').slice(-6).map((l, i, all) => (
            <Text key={i}>{l}{i === all.length - 1 ? <Text inverse> </Text> : null}</Text>
          ))}
        </Box>
      )}
      <Text color={status ? COLORS.comment : COLORS.dim}>{fitText(` ${status || (input ? 'enter save · alt-enter newline · ctrl-e $EDITOR · esc cancel' : hints)}`, columns)}</Text>
    </Box>
  )
}

export async function run(options: Options): Promise<void> {
  const app = render(<App {...options} />, { alternateScreen: true, exitOnCtrlC: false })
  await app.waitUntilExit()
}
