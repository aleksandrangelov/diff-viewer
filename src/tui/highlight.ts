import { basename, extname } from 'node:path'
import { bundledLanguagesInfo, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
import type { DiffLine, FileDiff } from '../diff.js'

export interface Segment {
  text: string
  color?: string
}

export type Highlights = Map<DiffLine, Segment[]>

const THEME = 'github-dark-default'
const MAX_LINES = 5000

const languages = new Map<string, BundledLanguage>()
for (const info of bundledLanguagesInfo) {
  for (const name of [info.id, ...(info.aliases ?? [])]) languages.set(name.toLowerCase(), info.id as BundledLanguage)
}
const byFilename: Record<string, string> = {
  dockerfile: 'docker', makefile: 'make', gemfile: 'ruby', rakefile: 'ruby', '.gitignore': 'ignore',
}
const byExtension: Record<string, string> = { mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', h: 'c', hpp: 'cpp', rake: 'ruby' }

let highlighter: Promise<Highlighter> | undefined

// Highlights each hunk's old and new side as contiguous code so multi-line constructs keep their context.
export async function highlightFile(file: FileDiff): Promise<Highlights> {
  const result: Highlights = new Map()
  const name = basename(file.path).toLowerCase()
  const ext = extname(name).slice(1)
  const lang = languages.get(byFilename[name] ?? byExtension[ext] ?? ext)
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0)
  if (!lang || file.binary || lineCount > MAX_LINES) return result

  highlighter ??= createHighlighter({ themes: [THEME], langs: [] })
  const hl = await highlighter
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang)

  for (const hunk of file.hunks) {
    for (const side of ['new', 'old'] as const) {
      const lines = hunk.lines.filter((l) => (side === 'new' ? l.kind !== 'del' : l.kind === 'del' || l.kind === 'ctx'))
      if (lines.length === 0) continue
      const tokens = hl.codeToTokensBase(lines.map((l) => l.text).join('\n'), { lang, theme: THEME })
      lines.forEach((line, i) => {
        if (side === 'old' && line.kind === 'ctx') return
        result.set(line, (tokens[i] ?? []).map((t) => ({ text: t.content, color: t.color })))
      })
    }
  }
  return result
}
