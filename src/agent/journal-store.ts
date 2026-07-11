import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type JournalKind = 'diary' | 'dream'

export interface JournalRecord {
  id: string
  kind: JournalKind
  content: string
  createdAt: string
}

export interface JournalStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
}

export interface JournalInput {
  kind: JournalKind
  content: string
}

export interface JournalQuery {
  kind?: JournalKind
  limit?: number
}

export interface JournalSearchQuery extends JournalQuery {
  query: string
}

export interface JournalEntriesResult {
  entries: JournalRecord[]
  skippedCorrupt: number
}

export interface JournalReadResult {
  entry: JournalRecord | null
  skippedCorrupt: number
}

export interface JournalRecordSnapshot {
  entry: JournalRecord
  file: string
  revision: string
}

export class JournalStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'revision_conflict' | 'invalid_selection',
    message: string,
  ) {
    super(message)
    this.name = 'JournalStoreError'
  }
}

interface JournalSegment {
  entry: JournalRecord
  start: number
  end: number
}

interface JournalFileSnapshot {
  path: string
  relativeFile: string
  raw: string
  revision: string
  segments: JournalSegment[]
}

function generateId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function journalFilePath(rootDir: string, kind: JournalKind, date: Date): string {
  return join(rootDir, 'journal', kind, `${monthKey(date)}.md`)
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

function assertRevision(raw: string, expectedRevision: string): void {
  if (revisionOf(raw) !== expectedRevision) {
    throw new JournalStoreError('revision_conflict', 'journal file changed; read the entry again and retry with the latest revision')
  }
}

export async function appendJournalRecord(
  options: JournalStoreOptions,
  input: JournalInput,
): Promise<JournalRecord> {
  const now = options.now?.() ?? new Date()
  const entry: JournalRecord = {
    id: options.id?.() ?? generateId(now),
    kind: input.kind,
    content: input.content,
    createdAt: now.toISOString(),
  }

  const path = journalFilePath(options.rootDir, input.kind, now)
  await ensureMonthlyJournalFile(path, input.kind, monthKey(now))
  await appendFile(path, renderMarkdownEntry(entry), 'utf8')
  return entry
}

export async function listJournalRecords(
  options: JournalStoreOptions,
  query: JournalQuery = {},
): Promise<JournalEntriesResult> {
  const result = await readEntries(options.rootDir)
  return {
    entries: applyEntryQuery(result.entries, query),
    skippedCorrupt: result.skippedCorrupt,
  }
}

export async function searchJournalRecords(
  options: JournalStoreOptions,
  query: JournalSearchQuery,
): Promise<JournalEntriesResult> {
  const needle = query.query.toLocaleLowerCase()
  const result = await readEntries(options.rootDir)
  const matches = result.entries.filter((entry) => entry.content.toLocaleLowerCase().includes(needle))
  return {
    entries: applyEntryQuery(matches, query),
    skippedCorrupt: result.skippedCorrupt,
  }
}

export async function readJournalRecord(
  options: JournalStoreOptions,
  id: string,
): Promise<JournalReadResult> {
  const result = await readEntries(options.rootDir)
  return {
    entry: result.entries.find((entry) => entry.id === id) ?? null,
    skippedCorrupt: result.skippedCorrupt,
  }
}

export async function readJournalRecordSnapshot(
  options: JournalStoreOptions,
  id: string,
): Promise<JournalRecordSnapshot | null> {
  const located = await findJournalFileByEntryId(options.rootDir, id)
  if (!located) return null
  const segment = located.segments.find((candidate) => candidate.entry.id === id)!
  return { entry: segment.entry, file: located.relativeFile, revision: located.revision }
}

export async function updateJournalRecord(
  options: JournalStoreOptions & { entryId: string; expectedRevision: string; content: string },
): Promise<JournalRecordSnapshot> {
  const located = await findJournalFileByEntryId(options.rootDir, options.entryId)
  if (!located) throw new JournalStoreError('not_found', `journal entry not found: ${options.entryId}`)
  assertRevision(located.raw, options.expectedRevision)
  const target = located.segments.find((candidate) => candidate.entry.id === options.entryId)!
  const entry = { ...target.entry, content: options.content }
  const raw = `${located.raw.slice(0, target.start)}${renderMarkdownEntry(entry)}${located.raw.slice(target.end)}`.trimEnd() + '\n'
  await atomicWrite(located.path, raw)
  return { entry, file: located.relativeFile, revision: revisionOf(raw) }
}

export async function deleteJournalRecord(
  options: JournalStoreOptions & { entryId: string; expectedRevision: string },
): Promise<{ id: string; file: string; revision: string }> {
  const located = await findJournalFileByEntryId(options.rootDir, options.entryId)
  if (!located) throw new JournalStoreError('not_found', `journal entry not found: ${options.entryId}`)
  assertRevision(located.raw, options.expectedRevision)
  const target = located.segments.find((candidate) => candidate.entry.id === options.entryId)!
  const raw = `${located.raw.slice(0, target.start)}${located.raw.slice(target.end)}`.trimEnd() + '\n'
  await atomicWrite(located.path, raw)
  return { id: options.entryId, file: located.relativeFile, revision: revisionOf(raw) }
}

export async function compactJournalRecords(
  options: JournalStoreOptions & { ids: string[]; expectedRevision: string; content: string },
): Promise<{ entry: JournalRecord; compactedIds: string[]; file: string; revision: string }> {
  if (new Set(options.ids).size !== options.ids.length || options.ids.length < 2) {
    throw new JournalStoreError('invalid_selection', 'compact requires at least two distinct journal entry ids')
  }
  const located = await findJournalFileByEntryId(options.rootDir, options.ids[0]!)
  if (!located) throw new JournalStoreError('not_found', 'one or more journal entries were not found')
  assertRevision(located.raw, options.expectedRevision)
  const selected = located.segments.filter((segment) => options.ids.includes(segment.entry.id))
  if (selected.length !== options.ids.length) {
    throw new JournalStoreError('invalid_selection', 'compact requires entries from the same journal month and kind')
  }

  const now = options.now?.() ?? new Date()
  const entry: JournalRecord = {
    id: options.id?.() ?? generateId(now),
    kind: selected[0]!.entry.kind,
    content: options.content,
    createdAt: now.toISOString(),
  }
  const firstStart = Math.min(...selected.map((segment) => segment.start))
  const selectedStarts = new Set(selected.map((segment) => segment.start))
  let cursor = 0
  let raw = ''
  for (const segment of located.segments) {
    if (!selectedStarts.has(segment.start)) continue
    raw += located.raw.slice(cursor, segment.start)
    if (segment.start === firstStart) raw += renderMarkdownEntry(entry)
    cursor = segment.end
  }
  raw = `${raw}${located.raw.slice(cursor)}`.trimEnd() + '\n'
  await atomicWrite(located.path, raw)
  return { entry, compactedIds: options.ids, file: located.relativeFile, revision: revisionOf(raw) }
}

async function findJournalFileByEntryId(rootDir: string, id: string): Promise<JournalFileSnapshot | null> {
  for (const kind of ['diary', 'dream'] as const) {
    const dir = join(rootDir, 'journal', kind)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') continue
      throw err
    }
    for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
      const path = join(dir, file)
      const raw = await readFile(path, 'utf8')
      const segments = parseMarkdownJournalSegments(raw, kind)
      if (segments.some((segment) => segment.entry.id === id)) {
        return { path, relativeFile: `${kind}/${file}`, raw, revision: revisionOf(raw), segments }
      }
    }
  }
  return null
}

async function readEntries(rootDir: string): Promise<JournalEntriesResult> {
  let skippedCorrupt = 0
  const entries: Array<JournalRecord & { index: number }> = []
  let index = 0

  for (const kind of ['diary', 'dream'] as const) {
    const result = await readKindEntries(rootDir, kind, index)
    skippedCorrupt += result.skippedCorrupt
    entries.push(...result.entries)
    index += result.entries.length
  }

  entries.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt)
    if (byTime !== 0) return byTime
    return b.index - a.index
  })

  return {
    entries: entries.map(({ index: _index, ...entry }) => entry),
    skippedCorrupt,
  }
}

function applyEntryQuery(entries: JournalRecord[], query: JournalQuery): JournalRecord[] {
  const filtered = query.kind ? entries.filter((entry) => entry.kind === query.kind) : entries
  return query.limit == null ? filtered : filtered.slice(0, query.limit)
}

async function ensureMonthlyJournalFile(path: string, kind: JournalKind, month: string): Promise<void> {
  try {
    await readFile(path, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `# ${kind === 'diary' ? 'Diary' : 'Dream'} ${month}\n\n`, 'utf8')
      return
    }
    throw err
  }
}

function renderMarkdownEntry(entry: JournalRecord): string {
  return [
    '<!-- journal-entry',
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `createdAt: ${entry.createdAt}`,
    '-->',
    entry.content,
    '<!-- /journal-entry -->',
    '',
  ].join('\n')
}

async function readKindEntries(
  rootDir: string,
  kind: JournalKind,
  startIndex: number,
): Promise<{ entries: Array<JournalRecord & { index: number }>; skippedCorrupt: number }> {
  const dir = join(rootDir, 'journal', kind)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { entries: [], skippedCorrupt: 0 }
    }
    throw err
  }

  const entries: Array<JournalRecord & { index: number }> = []
  let skippedCorrupt = 0
  let index = startIndex
  for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
    const parsed = parseMarkdownJournalFile(await readFile(join(dir, file), 'utf8'), kind, index)
    entries.push(...parsed.entries)
    skippedCorrupt += parsed.skippedCorrupt
    index += parsed.entries.length
  }
  return { entries, skippedCorrupt }
}

function parseMarkdownJournalFile(
  raw: string,
  expectedKind: JournalKind,
  startIndex: number,
): { entries: Array<JournalRecord & { index: number }>; skippedCorrupt: number } {
  const parsed = parseMarkdownJournalSegments(raw, expectedKind)
  return {
    entries: parsed.map((segment, offset) => ({ ...segment.entry, index: startIndex + offset })),
    skippedCorrupt: countCorruptJournalEntries(raw, expectedKind),
  }
}

function parseMarkdownJournalSegments(raw: string, expectedKind: JournalKind): JournalSegment[] {
  const segments: JournalSegment[] = []
  let offset = 0
  while (offset < raw.length) {
    const start = raw.indexOf('<!-- journal-entry', offset)
    if (start < 0) break
    const metaEnd = raw.indexOf('-->', start)
    if (metaEnd < 0) break
    const bodyStart = metaEnd + 3
    const close = raw.indexOf('<!-- /journal-entry -->', bodyStart)
    if (close < 0) break
    const endMarker = '<!-- /journal-entry -->'
    const end = close + endMarker.length + (raw.slice(close + endMarker.length).startsWith('\n') ? 1 : 0)
    const meta = raw.slice(start + '<!-- journal-entry'.length, metaEnd)
    const content = raw.slice(bodyStart, close).trim()
    const entry = parseMarkdownEntryMeta(meta, content)
    if (entry?.kind === expectedKind) segments.push({ entry, start, end })
    offset = Math.max(end, close + endMarker.length)
  }
  return segments
}

function countCorruptJournalEntries(raw: string, expectedKind: JournalKind): number {
  const starts = raw.match(/<!-- journal-entry/g)?.length ?? 0
  return Math.max(0, starts - parseMarkdownJournalSegments(raw, expectedKind).length)
}

function parseMarkdownEntryMeta(meta: string, content: string): JournalRecord | null {
  const fields = new Map<string, string>()
  for (const line of meta.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.+)$/.exec(line.trim())
    if (match) fields.set(match[1]!, match[2]!)
  }

  const id = fields.get('id')
  const kind = fields.get('kind')
  const createdAt = fields.get('createdAt')
  if (!id || (kind !== 'diary' && kind !== 'dream') || !createdAt || !content) return null
  return { id, kind, content, createdAt }
}
