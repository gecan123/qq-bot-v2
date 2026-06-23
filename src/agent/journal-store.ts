import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

function entriesPath(rootDir: string): string {
  return join(rootDir, 'journal', 'entries.jsonl')
}

function generateId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
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

  const path = entriesPath(options.rootDir)
  await mkdir(join(options.rootDir, 'journal'), { recursive: true })
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
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

async function readEntries(rootDir: string): Promise<JournalEntriesResult> {
  let raw: string
  try {
    raw = await readFile(entriesPath(rootDir), 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { entries: [], skippedCorrupt: 0 }
    }
    throw err
  }

  let skippedCorrupt = 0
  const entries: Array<JournalRecord & { index: number }> = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue
    const parsed = parseEntryLine(line)
    if (!parsed) {
      skippedCorrupt += 1
      continue
    }
    entries.push({ ...parsed, index })
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

function parseEntryLine(line: string): JournalRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record.id !== 'string') return null
  if (record.kind !== 'diary' && record.kind !== 'dream') return null
  if (typeof record.content !== 'string') return null
  if (typeof record.createdAt !== 'string') return null
  return {
    id: record.id,
    kind: record.kind,
    content: record.content,
    createdAt: record.createdAt,
  }
}
