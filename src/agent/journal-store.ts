import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

function generateId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function journalFilePath(rootDir: string, kind: JournalKind, date: Date): string {
  return join(rootDir, 'journal', kind, `${monthKey(date)}.md`)
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
  const entries: Array<JournalRecord & { index: number }> = []
  let skippedCorrupt = 0
  let offset = 0
  let index = startIndex

  while (offset < raw.length) {
    const start = raw.indexOf('<!-- journal-entry', offset)
    if (start < 0) break
    const metaEnd = raw.indexOf('-->', start)
    if (metaEnd < 0) {
      skippedCorrupt += 1
      break
    }
    const bodyStart = metaEnd + 3
    const end = raw.indexOf('<!-- /journal-entry -->', bodyStart)
    if (end < 0) {
      skippedCorrupt += 1
      break
    }

    const meta = raw.slice(start + '<!-- journal-entry'.length, metaEnd)
    const content = raw.slice(bodyStart, end).trim()
    const parsed = parseMarkdownEntryMeta(meta, content)
    if (!parsed || parsed.kind !== expectedKind) {
      skippedCorrupt += 1
    } else {
      entries.push({ ...parsed, index })
      index += 1
    }
    offset = end + '<!-- /journal-entry -->'.length
  }

  return { entries, skippedCorrupt }
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
