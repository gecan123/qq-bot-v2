import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  compareTimestampsDesc,
  formatBeijingCompact,
  formatBeijingIso,
  formatBeijingMonth,
} from '../utils/beijing-time.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'
import { atomicWriteText, revisionOfText, withResourceWrite } from './workspace-document.js'

export type NotebookKind = 'research' | 'reading' | 'market' | 'project' | 'general'

export interface NotebookRecord {
  id: string
  kind: NotebookKind
  topic: string
  content: string
  createdAt: string
  updatedAt: string
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

export interface NotebookCheckpointResult extends NotebookRecordSnapshot {
  created: boolean
  changed: boolean
  consolidatedIds: string[]
}

export class NotebookStoreError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'topic_limit_reached',
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

interface NotebookTopicMatch {
  snapshot: NotebookFileSnapshot
  segment: NotebookSegment
}

const NOTEBOOK_KINDS: readonly NotebookKind[] = ['research', 'reading', 'market', 'project', 'general']
const GENERAL_TOPIC_LIMIT = 5

function withCoordinatedWrite<T>(
  options: NotebookStoreOptions,
  resourceKey: string,
  task: () => Promise<T>,
): Promise<T> {
  return withResourceWrite(options.workspaceStateCoordinator, resourceKey, task)
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

function topicKey(kind: NotebookKind, topic: string): string {
  return `${kind}:${normalizeTopic(topic).toLocaleLowerCase()}`
}

function revisionOf(raw: string): string {
  return revisionOfText(raw)
}

async function atomicWrite(path: string, raw: string): Promise<void> {
  await atomicWriteText(path, raw)
}

export async function checkpointNotebookRecord(
  options: NotebookStoreOptions,
  input: NotebookInput,
): Promise<NotebookCheckpointResult> {
  const now = options.now?.() ?? new Date()
  const topic = normalizeTopic(input.topic)
  const content = input.content.trim()
  return withCoordinatedWrite(options, 'notebook', async () => {
    const matches = await findNotebookTopicMatches(options.rootDir, input.kind, topic)
    if (matches.length === 0) {
      if (input.kind === 'general') {
        const existingTopics = await currentTopicNames(options.rootDir, input.kind)
        if (existingTopics.length >= GENERAL_TOPIC_LIMIT) {
          throw new NotebookStoreError(
            'topic_limit_reached',
            `general notebook 最多维护 ${GENERAL_TOPIC_LIMIT} 个当前主题；请先 list，再用完全相同的 topic 更新其中一条。现有主题：${existingTopics.join('、')}`,
          )
        }
      }
      const month = formatBeijingMonth(now)
      const path = notebookFilePath(options.rootDir, input.kind, now)
      await ensureMonthlyNotebookFile(path, input.kind, month)
      const current = await readFile(path, 'utf8')
      const timestamp = formatBeijingIso(now)
      const entry: NotebookRecord = {
        id: options.id?.() ?? generateId(now),
        kind: input.kind,
        topic,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const raw = `${current.trimEnd()}\n\n${renderNotebookEntry(entry)}`
      await atomicWrite(path, raw)
      return {
        entry,
        file: `${input.kind}/${month}.md`,
        revision: revisionOf(raw),
        created: true,
        changed: true,
        consolidatedIds: [],
      }
    }

    const winner = matches[0]!
    const consolidatedIds = matches.slice(1).map((match) => match.segment.entry.id)
    if (winner.segment.entry.content === content && consolidatedIds.length === 0) {
      return {
        entry: winner.segment.entry,
        file: winner.snapshot.relativeFile,
        revision: winner.snapshot.revision,
        created: false,
        changed: false,
        consolidatedIds,
      }
    }

    const entry: NotebookRecord = {
      ...winner.segment.entry,
      content,
      updatedAt: formatBeijingIso(now),
    }
    const snapshots = uniqueTopicSnapshots(matches, winner.snapshot.path)
    let winnerRevision = winner.snapshot.revision
    for (const snapshot of snapshots) {
      const snapshotMatches = matches.filter((match) => match.snapshot.path === snapshot.path)
      const raw = rewriteTopicMatches(
        snapshot,
        snapshotMatches,
        snapshot.path === winner.snapshot.path ? entry : null,
      )
      await atomicWrite(snapshot.path, raw)
      if (snapshot.path === winner.snapshot.path) winnerRevision = revisionOf(raw)
    }
    return {
      entry,
      file: winner.snapshot.relativeFile,
      revision: winnerRevision,
      created: false,
      changed: true,
      consolidatedIds,
    }
  })
}

async function currentTopicNames(rootDir: string, kind: NotebookKind): Promise<string[]> {
  const result = await readKindEntries(rootDir, kind, 0)
  const topics = new Map<string, string>()
  for (const entry of result.entries) {
    const key = topicKey(kind, entry.topic)
    if (!topics.has(key)) topics.set(key, entry.topic)
  }
  return [...topics.values()]
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
    `updatedAt: ${entry.updatedAt}`,
    '-->',
    entry.content,
    '<!-- /notebook-entry -->',
    '',
  ].join('\n')
}

function uniqueTopicSnapshots(
  matches: NotebookTopicMatch[],
  winnerPath: string,
): NotebookFileSnapshot[] {
  const snapshots = new Map<string, NotebookFileSnapshot>()
  for (const match of matches) snapshots.set(match.snapshot.path, match.snapshot)
  const winner = snapshots.get(winnerPath)!
  snapshots.delete(winnerPath)
  return [winner, ...snapshots.values()]
}

function rewriteTopicMatches(
  snapshot: NotebookFileSnapshot,
  matches: NotebookTopicMatch[],
  replacement: NotebookRecord | null,
): string {
  const selectedStarts = new Set(matches.map((match) => match.segment.start))
  const winnerStart = replacement == null
    ? null
    : matches.find((match) => match.segment.entry.id === replacement.id)?.segment.start ?? null
  let cursor = 0
  let raw = ''
  for (const segment of snapshot.segments) {
    if (!selectedStarts.has(segment.start)) continue
    raw += snapshot.raw.slice(cursor, segment.start)
    if (segment.start === winnerStart) raw += renderNotebookEntry(replacement!)
    cursor = segment.end
  }
  return `${raw}${snapshot.raw.slice(cursor)}`.trimEnd() + '\n'
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
    compareTimestampsDesc(left.updatedAt, right.updatedAt)
    || compareTimestampsDesc(left.createdAt, right.createdAt)
    || right.index - left.index
  ))
  const currentEntries: typeof entries = []
  const seenTopics = new Set<string>()
  for (const entry of entries) {
    const key = topicKey(entry.kind, entry.topic)
    if (seenTopics.has(key)) continue
    seenTopics.add(key)
    currentEntries.push(entry)
  }
  return {
    entries: currentEntries.map(({ index: _index, ...entry }) => entry),
    skippedCorrupt,
  }
}

async function findNotebookTopicMatches(
  rootDir: string,
  kind: NotebookKind,
  topic: string,
): Promise<NotebookTopicMatch[]> {
  const directory = join(rootDir, 'notebook', kind)
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const key = topicKey(kind, topic)
  const matches: NotebookTopicMatch[] = []
  for (const file of files.filter((name) => name.endsWith('.md')).sort()) {
    const path = join(directory, file)
    const raw = await readFile(path, 'utf8')
    const snapshot: NotebookFileSnapshot = {
      path,
      relativeFile: `${kind}/${file}`,
      raw,
      revision: revisionOf(raw),
      segments: parseNotebookSegments(raw, kind),
    }
    for (const segment of snapshot.segments) {
      if (topicKey(segment.entry.kind, segment.entry.topic) === key) {
        matches.push({ snapshot, segment })
      }
    }
  }
  matches.sort((left, right) => (
    compareTimestampsDesc(left.segment.entry.updatedAt, right.segment.entry.updatedAt)
    || compareTimestampsDesc(left.segment.entry.createdAt, right.segment.entry.createdAt)
    || right.segment.start - left.segment.start
  ))
  return matches
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
    const updatedAt = fields.get('updatedAt') ?? createdAt
    const content = raw.slice(bodyStart, close).trim()
    if (id && kind === expectedKind && topic && createdAt && updatedAt && content) {
      segments.push({
        entry: { id, kind: expectedKind, topic, content, createdAt, updatedAt },
        start,
        end,
      })
    }
    offset = Math.max(end, close + closeMarker.length)
  }
  return segments
}
