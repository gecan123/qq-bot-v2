import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import { compareTimestampsDesc, formatBeijingCompact, formatBeijingIso } from '../utils/beijing-time.js'

export type MemoryScope = 'self' | 'person' | 'group' | 'topic'

export interface MemoryStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
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

export interface RecallMemoryInput {
  query: string
  scope?: MemoryScope
  limit?: number
}

export interface ReviewMemoryInput {
  scope?: MemoryScope
  file?: string
  limit?: number
}

export interface ReadMemoryInput {
  file: string
  offset?: number
  maxChars?: number
}

export interface ListMemoryInput {
  scope?: MemoryScope
  limit?: number
}

export interface DeleteMemoryInput {
  files: string[]
}

export interface MemoryWriteResult {
  ok: true
  file: string
  scope: MemoryScope
  title: string
  entryId: string
  revision: string
}

export interface MemoryEntry {
  id: string
  createdAt: string
  content: string
  sourceMessageIds: number[]
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

export interface MemoryRecallResult {
  ok: true
  matches: Array<{
    file: string
    scope: MemoryScope
    title: string
    updatedAt: string | null
    entryId: string
    createdAt: string
    content: string
    sourceMessageIds: number[]
    score: number
    matchedTerms: string[]
  }>
  skippedCorrupt: number
}

export interface MemoryReviewResult {
  ok: true
  proposals: Array<{
    relation: 'duplicate' | 'near_duplicate' | 'possible_conflict'
    file: string
    entryIds: [string, string]
    contents: [string, string]
    sourceMessageIds: number[]
    confidence: number
    reason: string
    next: string
  }>
  scannedEntries: number
  truncatedEntries: boolean
  skippedCorrupt: number
}

export type MemoryReadResult =
  | {
    ok: true
    file: string
    content: string
    truncated: boolean
    offset: number
    nextOffset: number | null
    totalChars: number
    revision: string
    entries: MemoryEntry[]
    entriesTruncated: boolean
  }
  | { ok: false; error: string }

export interface MemoryListResult {
  ok: true
  files: Array<{
    file: string
    scope: MemoryScope
    title: string
    updatedAt: string | null
    sizeBytes: number
  }>
  total: number
  truncated: boolean
  skippedCorrupt: number
}

export interface MemoryDeleteResult {
  ok: boolean
  deleted: string[]
  missing: string[]
  failed: Array<{ file: string; error: string }>
}

export class MemoryStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'revision_conflict' | 'invalid_selection' | 'invalid_format',
    message: string,
  ) {
    super(message)
    this.name = 'MemoryStoreError'
  }
}

interface MemorySegment extends MemoryEntry {
  start: number
  end: number
}

const DEFAULT_MAX_READ_CHARS = 4_000
const DEFAULT_MAX_SNIPPET_CHARS = 240
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 20
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_READ_ENTRIES = 50
const MAX_REVIEW_ENTRIES = 500
const ENTRY_START = '<!-- memory-entry'
const ENTRY_END = '<!-- /memory-entry -->'

export async function writeMemoryEntry(
  options: MemoryStoreOptions,
  input: WriteMemoryInput,
): Promise<MemoryWriteResult> {
  const now = options.now?.() ?? new Date()
  const nowIso = formatBeijingIso(now)
  const entryId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
  const relativeFile = fileForInput(input)
  const absoluteFile = safeMemoryFile(options.rootDir, relativeFile)
  await mkdir(dirname(absoluteFile), { recursive: true })

  const title = titleForInput(input)
  const existing = await readOptional(absoluteFile)
  const base = replaceUpdatedAt(
    existing && parseMarkdownMemory(existing)
      ? existing
      : renderNewFile(input.scope, title, nowIso),
    nowIso,
  )
  const raw = `${base.trimEnd()}\n${renderMemoryEntry({
    id: entryId,
    createdAt: nowIso,
    content: input.content.trim(),
    sourceMessageIds: input.sourceMessageIds ?? [],
  })}`
  await atomicWrite(absoluteFile, raw)
  return { ok: true, file: relativeFile, scope: input.scope, title, entryId, revision: revisionOf(raw) }
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
    const haystack = `${file}\n${parsed.title}\n${searchableMemoryText(raw)}`.toLocaleLowerCase()
    if (needle && !haystack.includes(needle)) continue
    matches.push({
      file,
      scope: parsed.scope,
      title: parsed.title,
      updatedAt: parsed.updatedAt,
      snippet: snippetFor(raw, needle ?? '', options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS),
    })
  }

  matches.sort((a, b) => compareTimestampsDesc(a.updatedAt, b.updatedAt) || a.file.localeCompare(b.file))
  return { ok: true, matches: matches.slice(0, limit), skippedCorrupt }
}

export async function recallMemoryEntries(
  options: MemoryStoreOptions,
  input: RecallMemoryInput,
): Promise<MemoryRecallResult> {
  const query = normalizeSearchText(input.query)
  const queryTerms = lexicalTerms(input.query)
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
  const root = memoryRoot(options.rootDir)
  const files = await listMarkdownFiles(root)
  const matches: MemoryRecallResult['matches'] = []
  let skippedCorrupt = 0

  for (const file of files) {
    const raw = await readFile(join(root, file), 'utf8')
    const parsed = parseMarkdownMemory(raw)
    if (!parsed) {
      skippedCorrupt++
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const titleText = normalizeSearchText(`${file} ${parsed.title}`)
    for (const entry of parseMemoryEntries(raw)) {
      const contentText = normalizeSearchText(entry.content)
      const matchedTerms = queryTerms.filter((term) => contentText.includes(term) || titleText.includes(term))
      const exactContent = query.length > 0 && contentText.includes(query)
      const exactTitle = query.length > 0 && titleText.includes(query)
      if (!exactContent && !exactTitle && matchedTerms.length === 0) continue
      const score = (exactContent ? 100 : 0)
        + (exactTitle ? 30 : 0)
        + matchedTerms.reduce((sum, term) => (
          sum + (contentText.includes(term) ? 5 : 0) + (titleText.includes(term) ? 2 : 0)
        ), 0)
      matches.push({
        file,
        scope: parsed.scope,
        title: parsed.title,
        updatedAt: parsed.updatedAt,
        entryId: entry.id,
        createdAt: entry.createdAt,
        content: entry.content,
        sourceMessageIds: entry.sourceMessageIds,
        score,
        matchedTerms: matchedTerms.slice(0, 12),
      })
    }
  }

  matches.sort((a, b) => (
    b.score - a.score
    || compareTimestampsDesc(a.updatedAt, b.updatedAt)
    || a.file.localeCompare(b.file)
    || a.entryId.localeCompare(b.entryId)
  ))
  return { ok: true, matches: matches.slice(0, limit), skippedCorrupt }
}

export async function proposeMemoryReview(
  options: MemoryStoreOptions,
  input: ReviewMemoryInput = {},
): Promise<MemoryReviewResult> {
  const root = memoryRoot(options.rootDir)
  const files = input.file ? [input.file] : await listMarkdownFiles(root)
  const entries: Array<{
    file: string
    scope: MemoryScope
    entry: MemoryEntry
    terms: Set<string>
    normalized: string
  }> = []
  let skippedCorrupt = 0

  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(input.file ? safeMemoryFile(options.rootDir, file) : join(root, file), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const parsed = parseMarkdownMemory(raw)
    if (!parsed) {
      skippedCorrupt++
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    for (const entry of parseMemoryEntries(raw)) {
      if (entries.length >= MAX_REVIEW_ENTRIES) break
      entries.push({
        file,
        scope: parsed.scope,
        entry,
        terms: new Set(lexicalTerms(entry.content)),
        normalized: normalizeSearchText(entry.content),
      })
    }
    if (entries.length >= MAX_REVIEW_ENTRIES) break
  }

  const proposals: MemoryReviewResult['proposals'] = []
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const left = entries[leftIndex]!
      const right = entries[rightIndex]!
      if (left.file !== right.file) continue
      const similarity = jaccard(left.terms, right.terms)
      const exact = left.normalized === right.normalized
      const polarityDiffers = hasNegation(left.entry.content) !== hasNegation(right.entry.content)
      const relation = exact
        ? 'duplicate'
        : polarityDiffers && similarity >= 0.4
          ? 'possible_conflict'
          : similarity >= 0.65
            ? 'near_duplicate'
            : null
      if (!relation) continue
      proposals.push({
        relation,
        file: left.file,
        entryIds: [left.entry.id, right.entry.id],
        contents: [left.entry.content, right.entry.content],
        sourceMessageIds: [...new Set([
          ...left.entry.sourceMessageIds,
          ...right.entry.sourceMessageIds,
        ])],
        confidence: Number((exact ? 1 : similarity).toFixed(3)),
        reason: relation === 'possible_conflict'
          ? '两条记忆词项高度重合但否定/变更语气不同，需要人工确认当前事实。'
          : '两条记忆内容相同或高度重合，可以在 read 后用 compact 合并。',
        next: `先 memory read file=${left.file} 获取最新 revision，再决定 compact/update_entry/delete_entry。`,
      })
    }
  }
  proposals.sort((a, b) => b.confidence - a.confidence || a.entryIds[0].localeCompare(b.entryIds[0]))
  return {
    ok: true,
    proposals: proposals.slice(0, limit),
    scannedEntries: entries.length,
    truncatedEntries: entries.length >= MAX_REVIEW_ENTRIES,
    skippedCorrupt,
  }
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
  if (!parseMarkdownMemory(raw)) {
    return { ok: false, error: 'memory file format is not supported' }
  }

  const offset = Math.min(input.offset ?? 0, raw.length)
  const max = Math.min(input.maxChars ?? options.maxReadChars ?? DEFAULT_MAX_READ_CHARS, 12_000)
  const content = raw.slice(offset, offset + max)
  const nextOffset = offset + content.length
  const parsedEntries = parseMemoryEntries(raw)
  const entries = parsedEntries.slice(0, MAX_READ_ENTRIES)
  return {
    ok: true,
    file: input.file,
    content,
    truncated: nextOffset < raw.length,
    offset,
    nextOffset: nextOffset < raw.length ? nextOffset : null,
    totalChars: raw.length,
    revision: revisionOf(raw),
    entries: entries.map(({ start: _start, end: _end, ...entry }) => entry),
    entriesTruncated: parsedEntries.length > entries.length,
  }
}

export async function updateMemoryEntry(
  options: MemoryStoreOptions,
  input: { file: string; entryId: string; expectedRevision: string; content: string },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (raw, entries) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    const updated = renderMemoryEntry({ ...target, content: input.content.trim() })
    return `${raw.slice(0, target.start)}${updated}${raw.slice(target.end)}`
  }, input.entryId)
}

export async function deleteMemoryEntry(
  options: MemoryStoreOptions,
  input: { file: string; entryId: string; expectedRevision: string },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (raw, entries) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    return `${raw.slice(0, target.start)}${raw.slice(target.end)}`
  }, input.entryId)
}

export async function compactMemoryEntries(
  options: MemoryStoreOptions,
  input: { file: string; entryIds: string[]; expectedRevision: string; content: string },
): Promise<{ ok: true; file: string; entryId: string; compactedEntryIds: string[]; revision: string }> {
  if (new Set(input.entryIds).size !== input.entryIds.length || input.entryIds.length < 2) {
    throw new MemoryStoreError('invalid_selection', 'compact requires at least two distinct memory entry ids')
  }
  const now = options.now?.() ?? new Date()
  const entryId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
  const result = await mutateMemoryFile(options, input.file, input.expectedRevision, (raw, entries) => {
    const selected = entries.filter((entry) => input.entryIds.includes(entry.id))
    if (selected.length !== input.entryIds.length) {
      throw new MemoryStoreError('not_found', 'one or more memory entries were not found')
    }
    const firstStart = Math.min(...selected.map((entry) => entry.start))
    const selectedStarts = new Set(selected.map((entry) => entry.start))
    const compacted = renderMemoryEntry({
      id: entryId,
      createdAt: formatBeijingIso(now),
      content: input.content.trim(),
      sourceMessageIds: [...new Set(selected.flatMap((entry) => entry.sourceMessageIds))],
    })
    let cursor = 0
    let output = ''
    for (const entry of entries) {
      if (!selectedStarts.has(entry.start)) continue
      output += raw.slice(cursor, entry.start)
      if (entry.start === firstStart) output += compacted
      cursor = entry.end
    }
    return output + raw.slice(cursor)
  }, entryId)
  return { ...result, compactedEntryIds: input.entryIds }
}

export async function listMemoryFiles(
  options: MemoryStoreOptions,
  input: ListMemoryInput = {},
): Promise<MemoryListResult> {
  const root = memoryRoot(options.rootDir)
  const files = await listMarkdownFiles(root)
  const matches: MemoryListResult['files'] = []
  let skippedCorrupt = 0

  for (const file of files) {
    const absoluteFile = join(root, file)
    const raw = await readFile(absoluteFile, 'utf8')
    const parsed = parseMarkdownMemory(raw)
    if (!parsed) {
      skippedCorrupt += 1
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const metadata = await stat(absoluteFile)
    matches.push({
      file,
      scope: parsed.scope,
      title: parsed.title,
      updatedAt: parsed.updatedAt,
      sizeBytes: metadata.size,
    })
  }

  matches.sort((a, b) => compareTimestampsDesc(a.updatedAt, b.updatedAt) || a.file.localeCompare(b.file))
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT)
  return {
    ok: true,
    files: matches.slice(0, limit),
    total: matches.length,
    truncated: matches.length > limit,
    skippedCorrupt,
  }
}

export async function deleteMemoryFiles(
  options: MemoryStoreOptions,
  input: DeleteMemoryInput,
): Promise<MemoryDeleteResult> {
  const deleted: string[] = []
  const missing: string[] = []
  const failed: MemoryDeleteResult['failed'] = []

  for (const file of input.files) {
    let absoluteFile: string
    try {
      absoluteFile = safeMemoryFile(options.rootDir, file)
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) })
      continue
    }

    try {
      await unlink(absoluteFile)
      deleted.push(file)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        missing.push(file)
      } else {
        failed.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return { ok: failed.length === 0, deleted, missing, failed }
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
    'formatVersion: 1',
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

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function atomicWrite(path: string, raw: string): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(tempPath, raw, 'utf8')
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

function renderMemoryEntry(entry: MemoryEntry): string {
  return [
    ENTRY_START,
    `id: ${entry.id}`,
    `createdAt: ${entry.createdAt}`,
    ...(entry.sourceMessageIds.length > 0 ? [`sourceMessageIds: ${entry.sourceMessageIds.join(',')}`] : []),
    '-->',
    `- ${entry.content}`,
    ENTRY_END,
    '',
  ].join('\n')
}

function parseMemoryEntries(raw: string): MemorySegment[] {
  const entries: MemorySegment[] = []
  let offset = 0
  while (offset < raw.length) {
    const start = raw.indexOf(ENTRY_START, offset)
    if (start < 0) break
    const metaEnd = raw.indexOf('-->', start + ENTRY_START.length)
    if (metaEnd < 0) break
    const close = raw.indexOf(ENTRY_END, metaEnd + 3)
    if (close < 0) break
    const end = close + ENTRY_END.length + (raw.slice(close + ENTRY_END.length).startsWith('\n') ? 1 : 0)
    const fields = new Map<string, string>()
    for (const line of raw.slice(start + ENTRY_START.length, metaEnd).split('\n')) {
      const match = /^([A-Za-z]+):\s*(.+)$/.exec(line.trim())
      if (match) fields.set(match[1]!, match[2]!)
    }
    const id = fields.get('id')
    const createdAt = fields.get('createdAt')
    const body = raw.slice(metaEnd + 3, close).replace(/^\n/, '').trim()
    if (id && createdAt && body.startsWith('- ')) {
      entries.push({
        id,
        createdAt,
        content: body.slice(2).trim(),
        sourceMessageIds: parseSourceIds(fields.get('sourceMessageIds')),
        start,
        end,
      })
    }
    offset = Math.max(end, close + ENTRY_END.length)
  }
  return entries
}

function parseSourceIds(raw: string | undefined): number[] {
  if (!raw) return []
  return raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value))
}

function searchableMemoryText(raw: string): string {
  return parseMemoryEntries(raw).map((entry) => entry.content).join('\n')
}

async function mutateMemoryFile(
  options: MemoryStoreOptions,
  file: string,
  expectedRevision: string,
  mutate: (raw: string, entries: MemorySegment[]) => string,
  entryId: string,
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  const path = safeMemoryFile(options.rootDir, file)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MemoryStoreError('not_found', `memory file not found: ${file}`)
    throw error
  }
  if (!parseMarkdownMemory(raw)) {
    throw new MemoryStoreError('invalid_format', `memory file uses an unsupported format: ${file}`)
  }
  if (revisionOf(raw) !== expectedRevision) {
    throw new MemoryStoreError('revision_conflict', 'memory file changed; read it again and retry with the latest revision')
  }
  const now = options.now?.() ?? new Date()
  const next = `${replaceUpdatedAt(mutate(raw, parseMemoryEntries(raw)), formatBeijingIso(now)).trimEnd()}\n`
  await atomicWrite(path, next)
  return { ok: true, file, entryId, revision: revisionOf(next) }
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
  if (record.formatVersion !== '1' || !isMemoryScope(record.scope)) return null
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

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function lexicalTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase()
  const terms = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]+|[\u3400-\u9fff]+/g)) {
    const chunk = match[0]
    if (/^[\u3400-\u9fff]+$/.test(chunk)) {
      if (chunk.length <= 20) terms.add(chunk)
      for (let index = 0; index < chunk.length - 1; index++) {
        terms.add(chunk.slice(index, index + 2))
      }
    } else if (chunk.length >= 2) {
      terms.add(chunk)
    }
  }
  return [...terms]
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const term of left) if (right.has(term)) intersection++
  return intersection / (left.size + right.size - intersection)
}

function hasNegation(value: string): boolean {
  return /(?:不再|不喜欢|不是|不要|取消|停止|改为|改成|\bnot\b|\bno longer\b)/iu.test(value)
}
