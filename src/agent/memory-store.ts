import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'

export type MemoryScope = 'self' | 'person' | 'group' | 'topic'

export interface MemoryStoreOptions {
  rootDir: string
  now?: () => Date
  maxReadChars?: number
  maxSnippetChars?: number
}

export interface WriteMemoryInput {
  scope: MemoryScope
  id?: string
  title?: string
  content: string
  sourceMessageIds?: number[]
}

export interface SearchMemoryInput {
  keyword?: string
  scope?: MemoryScope
  limit?: number
}

export interface ReadMemoryInput {
  file: string
}

export interface MemoryWriteResult {
  ok: true
  file: string
  scope: MemoryScope
  title: string
}

export interface MemorySearchMatch {
  file: string
  scope: MemoryScope
  title: string
  updatedAt: string | null
  snippet: string
}

export interface MemorySearchResult {
  ok: true
  matches: MemorySearchMatch[]
  skippedCorrupt: number
}

export type MemoryReadResult =
  | { ok: true; file: string; content: string; truncated: boolean }
  | { ok: false; error: string }

const DEFAULT_MAX_READ_CHARS = 4_000
const DEFAULT_MAX_SNIPPET_CHARS = 240
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 20

export async function writeMemoryEntry(
  options: MemoryStoreOptions,
  input: WriteMemoryInput,
): Promise<MemoryWriteResult> {
  const now = options.now?.() ?? new Date()
  const relativeFile = fileForInput(input)
  const absoluteFile = safeMemoryFile(options.rootDir, relativeFile)
  await mkdir(dirname(absoluteFile), { recursive: true })

  const title = titleForInput(input)
  const existing = await readOptional(absoluteFile)
  if (existing == null) {
    const initial = renderNewFile(input.scope, title, now.toISOString())
    await writeFile(absoluteFile, initial, 'utf8')
  } else {
    const updated = replaceUpdatedAt(existing, now.toISOString())
    if (updated !== existing) await writeFile(absoluteFile, updated, 'utf8')
  }

  await appendFile(absoluteFile, renderBullet(now, input), 'utf8')
  return { ok: true, file: relativeFile, scope: input.scope, title }
}

export async function searchMemoryEntries(
  options: MemoryStoreOptions,
  input: SearchMemoryInput = {},
): Promise<MemorySearchResult> {
  const root = memoryRoot(options.rootDir)
  const files = await listMarkdownFiles(root)
  const needle = input.keyword?.trim().toLocaleLowerCase()
  const limit = Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  const matches: MemorySearchMatch[] = []
  let skippedCorrupt = 0

  for (const file of files) {
    const raw = await readFile(join(root, file), 'utf8')
    const parsed = parseMarkdownMemory(raw)
    if (!parsed) {
      skippedCorrupt += 1
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const haystack = `${file}\n${parsed.title}\n${raw}`.toLocaleLowerCase()
    if (needle && !haystack.includes(needle)) continue
    matches.push({
      file,
      scope: parsed.scope,
      title: parsed.title,
      updatedAt: parsed.updatedAt,
      snippet: snippetFor(raw, needle ?? '', options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS),
    })
  }

  matches.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.file.localeCompare(b.file))
  return { ok: true, matches: matches.slice(0, limit), skippedCorrupt }
}

export async function readMemoryFile(
  options: MemoryStoreOptions,
  input: ReadMemoryInput,
): Promise<MemoryReadResult> {
  let absoluteFile: string
  try {
    absoluteFile = safeMemoryFile(options.rootDir, input.file)
  } catch {
    return { ok: false, error: 'memory file is not allowed' }
  }

  let raw: string
  try {
    raw = await readFile(absoluteFile, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { ok: false, error: 'memory file not found' }
    }
    throw err
  }

  const max = options.maxReadChars ?? DEFAULT_MAX_READ_CHARS
  if (raw.length <= max) return { ok: true, file: input.file, content: raw, truncated: false }
  return {
    ok: true,
    file: input.file,
    content: `${raw.slice(0, max)}\n[...truncated at ${max} chars]`,
    truncated: true,
  }
}

function memoryRoot(rootDir: string): string {
  return join(rootDir, 'memory')
}

function slug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled'
}

function titleForInput(input: WriteMemoryInput): string {
  if (input.title?.trim()) return input.title.trim()
  if (input.id?.trim()) return input.id.trim()
  if (input.scope === 'self') return 'working-notes'
  return input.scope
}

function fileForInput(input: WriteMemoryInput): string {
  if (input.scope === 'person') return `people/${requiredId(input)}.md`
  if (input.scope === 'group') return `groups/${requiredId(input)}.md`
  if (input.scope === 'topic') return `topics/${slug(titleForInput(input))}.md`
  return `self/${slug(titleForInput(input))}.md`
}

function requiredId(input: WriteMemoryInput): string {
  const value = input.id?.trim()
  if (!value) throw new Error(`${input.scope} memory requires id`)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${input.scope} id is invalid`)
  return value
}

function safeMemoryFile(rootDir: string, relativeFile: string): string {
  const normalized = normalize(relativeFile).replace(/\\/g, '/')
  if (!normalized.endsWith('.md') || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`memory file is not allowed: ${relativeFile}`)
  }
  const root = resolve(memoryRoot(rootDir))
  const resolved = resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`memory file escapes root: ${relativeFile}`)
  }
  return resolved
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

function renderNewFile(scope: MemoryScope, title: string, updatedAt: string): string {
  return [
    '---',
    `scope: ${scope}`,
    `title: ${title}`,
    `updatedAt: ${updatedAt}`,
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
    '## 最近线索',
    '',
  ].join('\n')
}

function replaceUpdatedAt(raw: string, updatedAt: string): string {
  if (!raw.startsWith('---\n')) return raw
  if (/^updatedAt: .+$/m.test(raw)) return raw.replace(/^updatedAt: .+$/m, `updatedAt: ${updatedAt}`)
  return raw.replace(/^---\n/, `---\nupdatedAt: ${updatedAt}\n`)
}

function renderBullet(now: Date, input: WriteMemoryInput): string {
  const suffix = input.sourceMessageIds?.length
    ? ` (sourceMessageIds: ${input.sourceMessageIds.join(',')})`
    : ''
  return `- ${now.toISOString()}: ${input.content.trim()}${suffix}\n`
}

function parseMarkdownMemory(raw: string): { scope: MemoryScope; title: string; updatedAt: string | null } | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) return null
  const frontmatter = raw.slice(4, end).split('\n')
  const record: Record<string, string> = {}
  for (const line of frontmatter) {
    if (!line.trim()) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) return null
    record[match[1]!] = match[2]!
  }
  if (!isMemoryScope(record.scope)) return null
  return {
    scope: record.scope,
    title: record.title || 'untitled',
    updatedAt: record.updatedAt || null,
  }
}

function isMemoryScope(value: string | undefined): value is MemoryScope {
  return value === 'self' || value === 'person' || value === 'group' || value === 'topic'
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), relative)
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative)
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
      throw err
    }
  }
  await walk(root, '')
  return result.sort()
}

function snippetFor(raw: string, needle: string, maxChars: number): string {
  const bodyMarker = raw.indexOf('\n---\n')
  const bodyStart = bodyMarker >= 0 ? bodyMarker + 5 : 0
  const body = raw.slice(bodyStart).replace(/\s+/g, ' ').trim()
  const lower = body.toLocaleLowerCase()
  const idx = needle ? lower.indexOf(needle) : 0
  const start = Math.max(0, idx - 60)
  const snippet = body.slice(start, start + maxChars)
  return `${start > 0 ? '...' : ''}${snippet}${start + maxChars < body.length ? '...' : ''}`
}
