import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  compareTimestampsDesc,
  formatBeijingCompact,
  formatBeijingIso,
  formatBeijingMonth,
} from '../utils/beijing-time.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

export type NotebookKind = 'research' | 'reading' | 'market' | 'project' | 'general'

export interface NotebookRecord {
  id: string
  kind: NotebookKind
  topic: string
  content: string
  createdAt: string
}

export interface NotebookStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

export interface NotebookInput {
  kind: NotebookKind
  topic: string
  content: string
}

export interface NotebookQuery {
  kind?: NotebookKind
  topic?: string
  limit?: number
}

export interface NotebookSearchQuery extends NotebookQuery {
  query: string
}

export interface NotebookEntriesResult {
  entries: NotebookRecord[]
  skippedCorrupt: number
}

export interface NotebookRecordSnapshot {
  entry: NotebookRecord
  file: string
  revision: string
}

export class NotebookStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'revision_conflict' | 'invalid_selection' | 'invalid_input',
    message: string,
  ) {
    super(message)
    this.name = 'NotebookStoreError'
  }
}

interface NotebookSegment {
  entry: NotebookRecord
  start: number
  end: number
}

interface NotebookFileSnapshot {
  path: string
  relativeFile: string
  raw: string
  revision: string
  segments: NotebookSegment[]
}

const NOTEBOOK_KINDS: readonly NotebookKind[] = ['research', 'reading', 'market', 'project', 'general']

function withCoordinatedWrite<T>(
  options: NotebookStoreOptions,
  resourceKey: string,
  task: () => Promise<T>,
): Promise<T> {
  return options.workspaceStateCoordinator
    ? options.workspaceStateCoordinator.withWrite(resourceKey, task)
    : task()
}

function generateId(now: Date): string {
  return `note_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
}

function notebookFilePath(rootDir: string, kind: NotebookKind, date: Date): string {
  return join(rootDir, 'notebook', kind, `${formatBeijingMonth(date)}.md`)
}

function notebookHeading(kind: NotebookKind, month: string): string {
  return `# ${kind[0]!.toUpperCase()}${kind.slice(1)} Notebook ${month}`
}

function normalizeTopic(topic: string): string {
  const normalized = topic.trim()
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new NotebookStoreError('invalid_input', 'notebook topic must be one non-empty line')
  }
  return normalized
}

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function atomicWrite(path: string, raw: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, raw, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function assertRevision(raw: string, expectedRevision: string): void {
  if (revisionOf(raw) !== expectedRevision) {
    throw new NotebookStoreError(
      'revision_conflict',
      'notebook file changed; read the entry again and retry with the latest revision',
    )
  }
}

export async function appendNotebookRecord(
  options: NotebookStoreOptions,
  input: NotebookInput,
): Promise<NotebookRecord> {
  const now = options.now?.() ?? new Date()
  const month = formatBeijingMonth(now)
  const resourceKey = `notebook:${input.kind}/${month}.md`
  const write = async (): Promise<NotebookRecord> => {
    const entry: NotebookRecord = {
      id: options.id?.() ?? generateId(now),
      kind: input.kind,
      topic: normalizeTopic(input.topic),
      content: input.content.trim(),
      createdAt: formatBeijingIso(now),
    }
    const path = notebookFilePath(options.rootDir, input.kind, now)
    await ensureMonthlyNotebookFile(path, input.kind, month)
    const current = await readFile(path, 'utf8')
    await atomicWrite(path, `${current.trimEnd()}\n\n${renderNotebookEntry(entry)}`)
    return entry
  }

  return withCoordinatedWrite(options, resourceKey, write)
}

export async function listNotebookRecords(
  options: NotebookStoreOptions,
  query: NotebookQuery = {},
): Promise<NotebookEntriesResult> {
  const result = await readEntries(options.rootDir)
  return {
    entries: applyQuery(result.entries, query),
    skippedCorrupt: result.skippedCorrupt,
  }
}

export async function searchNotebookRecords(
  options: NotebookStoreOptions,
  query: NotebookSearchQuery,
): Promise<NotebookEntriesResult> {
  const needle = query.query.toLocaleLowerCase()
  const result = await readEntries(options.rootDir)
  const matches = result.entries.filter((entry) => (
    entry.topic.toLocaleLowerCase().includes(needle)
    || entry.content.toLocaleLowerCase().includes(needle)
  ))
  return {
    entries: applyQuery(matches, query),
    skippedCorrupt: result.skippedCorrupt,
  }
}

export async function readNotebookRecordSnapshot(
  options: NotebookStoreOptions,
  id: string,
): Promise<NotebookRecordSnapshot | null> {
  const located = await findNotebookFileByEntryId(options.rootDir, id)
  if (!located) return null
  const segment = located.segments.find((candidate) => candidate.entry.id === id)!
  return { entry: segment.entry, file: located.relativeFile, revision: located.revision }
}

export async function updateNotebookRecord(
  options: NotebookStoreOptions & {
    entryId: string
    expectedRevision: string
    content: string
    topic?: string
  },
): Promise<NotebookRecordSnapshot> {
  const route = await findNotebookFileByEntryId(options.rootDir, options.entryId)
  if (!route) throw new NotebookStoreError('not_found', `notebook entry not found: ${options.entryId}`)
  return withCoordinatedWrite(options, `notebook:${route.relativeFile}`, async () => {
    const located = await findNotebookFileByEntryId(options.rootDir, options.entryId)
    if (!located) throw new NotebookStoreError('not_found', `notebook entry not found: ${options.entryId}`)
    assertRevision(located.raw, options.expectedRevision)
    const target = located.segments.find((candidate) => candidate.entry.id === options.entryId)!
    const entry = {
      ...target.entry,
      topic: options.topic == null ? target.entry.topic : normalizeTopic(options.topic),
      content: options.content.trim(),
    }
    const raw = `${located.raw.slice(0, target.start)}${renderNotebookEntry(entry)}${located.raw.slice(target.end)}`.trimEnd() + '\n'
    await atomicWrite(located.path, raw)
    return { entry, file: located.relativeFile, revision: revisionOf(raw) }
  })
}

export async function deleteNotebookRecord(
  options: NotebookStoreOptions & { entryId: string; expectedRevision: string },
): Promise<{ id: string; file: string; revision: string }> {
  const route = await findNotebookFileByEntryId(options.rootDir, options.entryId)
  if (!route) throw new NotebookStoreError('not_found', `notebook entry not found: ${options.entryId}`)
  return withCoordinatedWrite(options, `notebook:${route.relativeFile}`, async () => {
    const located = await findNotebookFileByEntryId(options.rootDir, options.entryId)
    if (!located) throw new NotebookStoreError('not_found', `notebook entry not found: ${options.entryId}`)
    assertRevision(located.raw, options.expectedRevision)
    const target = located.segments.find((candidate) => candidate.entry.id === options.entryId)!
    const raw = `${located.raw.slice(0, target.start)}${located.raw.slice(target.end)}`.trimEnd() + '\n'
    await atomicWrite(located.path, raw)
    return { id: options.entryId, file: located.relativeFile, revision: revisionOf(raw) }
  })
}

export async function compactNotebookRecords(
  options: NotebookStoreOptions & {
    ids: string[]
    expectedRevision: string
    content: string
  },
): Promise<{ entry: NotebookRecord; compactedIds: string[]; file: string; revision: string }> {
  if (new Set(options.ids).size !== options.ids.length || options.ids.length < 2) {
    throw new NotebookStoreError('invalid_selection', 'compact requires at least two distinct notebook entry ids')
  }
  const route = await findNotebookFileByEntryId(options.rootDir, options.ids[0]!)
  if (!route) throw new NotebookStoreError('not_found', 'one or more notebook entries were not found')
  return withCoordinatedWrite(options, `notebook:${route.relativeFile}`, async () => {
    const located = await findNotebookFileByEntryId(options.rootDir, options.ids[0]!)
    if (!located) throw new NotebookStoreError('not_found', 'one or more notebook entries were not found')
    assertRevision(located.raw, options.expectedRevision)
    const selected = located.segments.filter((segment) => options.ids.includes(segment.entry.id))
    if (selected.length !== options.ids.length) {
      throw new NotebookStoreError('invalid_selection', 'compact requires entries from the same notebook month and kind')
    }
    const topics = new Set(selected.map((segment) => segment.entry.topic.toLocaleLowerCase()))
    if (topics.size !== 1) {
      throw new NotebookStoreError('invalid_selection', 'compact requires entries from the same notebook topic')
    }

    const now = options.now?.() ?? new Date()
    const entry: NotebookRecord = {
      id: options.id?.() ?? generateId(now),
      kind: selected[0]!.entry.kind,
      topic: selected[0]!.entry.topic,
      content: options.content.trim(),
      createdAt: formatBeijingIso(now),
    }
    const firstStart = Math.min(...selected.map((segment) => segment.start))
    const selectedStarts = new Set(selected.map((segment) => segment.start))
    let cursor = 0
    let raw = ''
    for (const segment of located.segments) {
      if (!selectedStarts.has(segment.start)) continue
      raw += located.raw.slice(cursor, segment.start)
      if (segment.start === firstStart) raw += renderNotebookEntry(entry)
      cursor = segment.end
    }
    raw = `${raw}${located.raw.slice(cursor)}`.trimEnd() + '\n'
    await atomicWrite(located.path, raw)
    return { entry, compactedIds: options.ids, file: located.relativeFile, revision: revisionOf(raw) }
  })
}

async function ensureMonthlyNotebookFile(
  path: string,
  kind: NotebookKind,
  month: string,
): Promise<void> {
  try {
    await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${notebookHeading(kind, month)}\n\n`, 'utf8')
  }
}

function renderNotebookEntry(entry: NotebookRecord): string {
  return [
    '<!-- notebook-entry',
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `topic: ${entry.topic}`,
    `createdAt: ${entry.createdAt}`,
    '-->',
    entry.content,
    '<!-- /notebook-entry -->',
    '',
  ].join('\n')
}

async function readEntries(rootDir: string): Promise<NotebookEntriesResult> {
  const entries: Array<NotebookRecord & { index: number }> = []
  let skippedCorrupt = 0
  let index = 0
  for (const kind of NOTEBOOK_KINDS) {
    const result = await readKindEntries(rootDir, kind, index)
    entries.push(...result.entries)
    skippedCorrupt += result.skippedCorrupt
    index += result.entries.length
  }
  entries.sort((left, right) => (
    compareTimestampsDesc(left.createdAt, right.createdAt) || right.index - left.index
  ))
  return {
    entries: entries.map(({ index: _index, ...entry }) => entry),
    skippedCorrupt,
  }
}

function applyQuery(entries: NotebookRecord[], query: NotebookQuery): NotebookRecord[] {
  const topic = query.topic?.trim().toLocaleLowerCase()
  const filtered = entries.filter((entry) => (
    (!query.kind || entry.kind === query.kind)
    && (!topic || entry.topic.toLocaleLowerCase() === topic)
  ))
  return query.limit == null ? filtered : filtered.slice(0, query.limit)
}

async function readKindEntries(
  rootDir: string,
  kind: NotebookKind,
  startIndex: number,
): Promise<{ entries: Array<NotebookRecord & { index: number }>; skippedCorrupt: number }> {
  const directory = join(rootDir, 'notebook', kind)
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], skippedCorrupt: 0 }
    throw error
  }
  const entries: Array<NotebookRecord & { index: number }> = []
  let skippedCorrupt = 0
  let index = startIndex
  for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
    const raw = await readFile(join(directory, file), 'utf8')
    const segments = parseNotebookSegments(raw, kind)
    entries.push(...segments.map((segment, offset) => ({ ...segment.entry, index: index + offset })))
    skippedCorrupt += Math.max(0, (raw.match(/<!-- notebook-entry/g)?.length ?? 0) - segments.length)
    index += segments.length
  }
  return { entries, skippedCorrupt }
}

async function findNotebookFileByEntryId(rootDir: string, id: string): Promise<NotebookFileSnapshot | null> {
  for (const kind of NOTEBOOK_KINDS) {
    const directory = join(rootDir, 'notebook', kind)
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
      const path = join(directory, file)
      const raw = await readFile(path, 'utf8')
      const segments = parseNotebookSegments(raw, kind)
      if (segments.some((segment) => segment.entry.id === id)) {
        return {
          path,
          relativeFile: `${kind}/${file}`,
          raw,
          revision: revisionOf(raw),
          segments,
        }
      }
    }
  }
  return null
}

function parseNotebookSegments(raw: string, expectedKind: NotebookKind): NotebookSegment[] {
  const segments: NotebookSegment[] = []
  let offset = 0
  while (offset < raw.length) {
    const start = raw.indexOf('<!-- notebook-entry', offset)
    if (start < 0) break
    const metaEnd = raw.indexOf('-->', start)
    if (metaEnd < 0) break
    const bodyStart = metaEnd + 3
    const closeMarker = '<!-- /notebook-entry -->'
    const close = raw.indexOf(closeMarker, bodyStart)
    if (close < 0) break
    const end = close + closeMarker.length + (raw.slice(close + closeMarker.length).startsWith('\n') ? 1 : 0)
    const fields = new Map<string, string>()
    for (const line of raw.slice(start + '<!-- notebook-entry'.length, metaEnd).split('\n')) {
      const match = /^([A-Za-z]+):\s*(.+)$/.exec(line.trim())
      if (match) fields.set(match[1]!, match[2]!)
    }
    const id = fields.get('id')
    const kind = fields.get('kind')
    const topic = fields.get('topic')
    const createdAt = fields.get('createdAt')
    const content = raw.slice(bodyStart, close).trim()
    if (id && kind === expectedKind && topic && createdAt && content) {
      segments.push({
        entry: { id, kind: expectedKind, topic, content, createdAt },
        start,
        end,
      })
    }
    offset = Math.max(end, close + closeMarker.length)
  }
  return segments
}
