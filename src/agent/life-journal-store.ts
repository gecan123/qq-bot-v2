import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatBeijingCompact, formatBeijingIso } from '../utils/beijing-time.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

export interface LifeJournalStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

export type LifeJournalEntrySource = 'manual' | 'round' | 'compact'
export type LifeJournalEntryKind = 'reflection' | 'dream'

export interface LifeJournalEntry {
  id: string
  date: string
  heading: string
  markdown: string
  kind: LifeJournalEntryKind
  source: LifeJournalEntrySource
  createdAt: string
  roundIndex?: number
}

export interface LifeJournalFile {
  path: string
  date: string
  content: string
  revision: string
  entries: LifeJournalEntry[]
}

export class LifeJournalStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'revision_conflict' | 'invalid_selection' | 'invalid_format',
    message: string,
  ) {
    super(message)
    this.name = 'LifeJournalStoreError'
  }
}

interface ParsedEntry extends LifeJournalEntry {
  start: number
  end: number
}

const AGENDA_TEMPLATE = `# Agenda

## Active
- [ ] Keep noticing what matters now.

## Waiting

## Someday

## Done
`

const ENTRY_START = '<!-- life-journal-entry'
const ENTRY_META_END = '-->'
const ENTRY_END = '<!-- /life-journal-entry -->'
const FORMAT_MARKER = '<!-- life-journal-format: 2 -->'
const AGENDA_RESOURCE_KEY = 'life-agenda:agenda.md'

function withCoordinatedWrite<T>(
  options: LifeJournalStoreOptions,
  resourceKey: string,
  task: () => Promise<T>,
): Promise<T> {
  return options.workspaceStateCoordinator
    ? options.workspaceStateCoordinator.withWrite(resourceKey, task)
    : task()
}

function currentDate(options: LifeJournalStoreOptions): Date {
  return options.now?.() ?? new Date()
}

function shanghaiParts(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  }
}

function lifeDir(rootDir: string): string {
  return join(rootDir, 'life')
}

function agendaPath(rootDir: string): string {
  return join(lifeDir(rootDir), 'agenda.md')
}

function journalDir(rootDir: string): string {
  return join(lifeDir(rootDir), 'journal')
}

function journalPath(rootDir: string, date: string): string {
  return join(journalDir(rootDir), `${date}.md`)
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function createEntryId(options: LifeJournalStoreOptions, date: Date): string {
  if (options.id) return options.id()
  return `lj_${formatBeijingCompact(date)}_${randomUUID().slice(0, 8)}`
}

function renderEntry(entry: LifeJournalEntry): string {
  const meta = [
    ENTRY_START,
    `id: ${entry.id}`,
    `date: ${entry.date}`,
    `kind: ${entry.kind}`,
    `source: ${entry.source}`,
    `createdAt: ${entry.createdAt}`,
    ...(entry.roundIndex == null ? [] : [`roundIndex: ${entry.roundIndex}`]),
    ENTRY_META_END,
  ]
  const body = entry.markdown.endsWith('\n') ? entry.markdown : `${entry.markdown}\n`
  return `${meta.join('\n')}\n${entry.heading}\n\n${body}${ENTRY_END}\n\n`
}

function parseMeta(raw: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.+)$/.exec(line.trim())
    if (match) fields.set(match[1]!, match[2]!)
  }
  return fields
}

function parseEntries(content: string, expectedDate: string): ParsedEntry[] {
  if (!content.startsWith(`# Life Journal ${expectedDate}\n\n${FORMAT_MARKER}\n`)) {
    throw new LifeJournalStoreError('invalid_format', `life journal day uses an unsupported format: ${expectedDate}`)
  }
  const entries: ParsedEntry[] = []
  let offset = 0
  while (offset < content.length) {
    const start = content.indexOf(ENTRY_START, offset)
    if (start < 0) break
    const metaEnd = content.indexOf(ENTRY_META_END, start + ENTRY_START.length)
    if (metaEnd < 0) break
    const close = content.indexOf(ENTRY_END, metaEnd + ENTRY_META_END.length)
    if (close < 0) break
    const end = close + ENTRY_END.length + (content.slice(close + ENTRY_END.length).startsWith('\n\n') ? 2 : 0)
    const fields = parseMeta(content.slice(start + ENTRY_START.length, metaEnd))
    const body = content.slice(metaEnd + ENTRY_META_END.length, close).replace(/^\n/, '').trimEnd()
    const headingEnd = body.indexOf('\n')
    const heading = headingEnd < 0 ? body : body.slice(0, headingEnd)
    const markdown = headingEnd < 0 ? '' : body.slice(headingEnd).replace(/^\n+/, '')
    const source = fields.get('source')
    const kind = fields.get('kind')
    const roundIndex = fields.get('roundIndex')
    const id = fields.get('id')
    const date = fields.get('date')
    const createdAt = fields.get('createdAt')
    const parsedRoundIndex = roundIndex && /^\d+$/.test(roundIndex) ? Number(roundIndex) : undefined
    const roundHeading = /^## \d{2}:\d{2} Round (\d+)$/.exec(heading)
    const headingMatchesSource = source === 'manual'
      ? /^## \d{2}:\d{2} Manual$/.test(heading)
      : source === 'compact'
        ? /^## \d{2}:\d{2} Compact$/.test(heading)
        : source === 'round' && parsedRoundIndex != null
          ? Number(roundHeading?.[1]) === parsedRoundIndex
          : false
    if (
      id
      && date === expectedDate
      && createdAt
      && (kind === 'reflection' || kind === 'dream')
      && headingMatchesSource
      && (source === 'manual' || source === 'round' || source === 'compact')
    ) {
      entries.push({
        id,
        date,
        heading,
        markdown,
        kind,
        source,
        createdAt,
        ...(parsedRoundIndex == null ? {} : { roundIndex: parsedRoundIndex }),
        start,
        end,
      })
    }
    offset = Math.max(end, close + ENTRY_END.length)
  }
  return entries
}

async function readJournalFile(rootDir: string, date: string): Promise<LifeJournalFile> {
  const path = journalPath(rootDir, date)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LifeJournalStoreError('not_found', `life journal day not found: ${date}`)
    }
    throw error
  }
  return {
    path,
    date,
    content,
    revision: revisionOf(content),
    entries: parseEntries(content, date).map(({ start: _start, end: _end, ...entry }) => entry),
  }
}

export async function readLifeJournalDay(
  options: LifeJournalStoreOptions & { date: string },
): Promise<LifeJournalFile> {
  return readJournalFile(options.rootDir, options.date)
}

export async function readLifeJournalEntry(
  options: LifeJournalStoreOptions & { date: string; entryId: string },
): Promise<{ path: string; revision: string; entry: LifeJournalEntry }> {
  const file = await readJournalFile(options.rootDir, options.date)
  const entry = file.entries.find((candidate) => candidate.id === options.entryId)
  if (!entry) throw new LifeJournalStoreError('not_found', `life journal entry not found: ${options.entryId}`)
  return { path: file.path, revision: file.revision, entry }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

function assertRevision(content: string, expectedRevision: string): void {
  if (revisionOf(content) !== expectedRevision) {
    throw new LifeJournalStoreError('revision_conflict', 'life journal changed; read_recent and retry with the latest revision')
  }
}

function normalizedFile(content: string): string {
  return `${content.trimEnd()}\n`
}

export async function appendLifeJournalEntry(
  options: LifeJournalStoreOptions & {
    roundIndex?: number
    kind?: LifeJournalEntryKind
    markdown: string
  },
): Promise<{ path: string; heading: string; entryId: string }> {
  const now = currentDate(options)
  const { date, time } = shanghaiParts(now)
  const write = async (): Promise<{ path: string; heading: string; entryId: string }> => {
    const path = journalPath(options.rootDir, date)
    const heading = options.roundIndex == null ? `## ${time} Manual` : `## ${time} Round ${options.roundIndex}`
    const entryId = createEntryId(options, now)

    await mkdir(journalDir(options.rootDir), { recursive: true })
    let resetFile = false
    try {
      const existing = await readFile(path, 'utf8')
      resetFile = !existing.startsWith(`# Life Journal ${date}\n\n${FORMAT_MARKER}\n`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      resetFile = true
    }
    if (resetFile) await writeFile(path, `# Life Journal ${date}\n\n${FORMAT_MARKER}\n\n`, 'utf8')

    const current = await readFile(path, 'utf8')
    const entry = renderEntry({
      id: entryId,
      date,
      heading,
      markdown: options.markdown,
      kind: options.kind ?? 'reflection',
      source: options.roundIndex == null ? 'manual' : 'round',
      createdAt: formatBeijingIso(now),
      ...(options.roundIndex == null ? {} : { roundIndex: options.roundIndex }),
    })
    await atomicWrite(path, `${current.trimEnd()}\n\n${entry}`)
    return { path, heading, entryId }
  }

  return withCoordinatedWrite(options, `life-journal:${date}.md`, write)
}

export async function updateLifeJournalEntry(
  options: LifeJournalStoreOptions & { date: string; entryId: string; expectedRevision: string; markdown: string },
): Promise<{ path: string; entry: LifeJournalEntry; revision: string }> {
  return withCoordinatedWrite(options, `life-journal:${options.date}.md`, async () => {
    const file = await readJournalFile(options.rootDir, options.date)
    assertRevision(file.content, options.expectedRevision)
    const entries = parseEntries(file.content, options.date)
    const target = entries.find((entry) => entry.id === options.entryId)
    if (!target) throw new LifeJournalStoreError('not_found', `life journal entry not found: ${options.entryId}`)

    const updated: LifeJournalEntry = {
      id: target.id,
      date: target.date,
      heading: target.heading,
      markdown: options.markdown,
      kind: target.kind,
      source: target.source,
      createdAt: target.createdAt,
      ...(target.roundIndex == null ? {} : { roundIndex: target.roundIndex }),
    }
    const content = normalizedFile(`${file.content.slice(0, target.start)}${renderEntry(updated)}${file.content.slice(target.end)}`)
    await atomicWrite(file.path, content)
    return { path: file.path, entry: updated, revision: revisionOf(content) }
  })
}

export async function deleteLifeJournalEntry(
  options: LifeJournalStoreOptions & { date: string; entryId: string; expectedRevision: string },
): Promise<{ path: string; deletedEntryId: string; revision: string }> {
  return withCoordinatedWrite(options, `life-journal:${options.date}.md`, async () => {
    const file = await readJournalFile(options.rootDir, options.date)
    assertRevision(file.content, options.expectedRevision)
    const target = parseEntries(file.content, options.date).find((entry) => entry.id === options.entryId)
    if (!target) throw new LifeJournalStoreError('not_found', `life journal entry not found: ${options.entryId}`)

    const content = normalizedFile(`${file.content.slice(0, target.start)}${file.content.slice(target.end)}`)
    await atomicWrite(file.path, content)
    return { path: file.path, deletedEntryId: target.id, revision: revisionOf(content) }
  })
}

export async function compactLifeJournalEntries(
  options: LifeJournalStoreOptions & {
    date: string
    entryIds: string[]
    expectedRevision: string
    markdown: string
  },
): Promise<{ path: string; entry: LifeJournalEntry; compactedEntryIds: string[]; revision: string }> {
  return withCoordinatedWrite(options, `life-journal:${options.date}.md`, async () => {
    const file = await readJournalFile(options.rootDir, options.date)
    assertRevision(file.content, options.expectedRevision)
    const entries = parseEntries(file.content, options.date)
    const selected = entries.filter((entry) => options.entryIds.includes(entry.id))
    if (selected.length !== options.entryIds.length) {
      throw new LifeJournalStoreError('not_found', 'one or more life journal entries were not found')
    }
    if (new Set(options.entryIds).size !== options.entryIds.length || selected.length < 2) {
      throw new LifeJournalStoreError('invalid_selection', 'compact requires at least two distinct entry ids')
    }

    const now = currentDate(options)
    const { time } = shanghaiParts(now)
    const compacted: LifeJournalEntry = {
      id: createEntryId(options, now),
      date: options.date,
      heading: `## ${time} Compact`,
      markdown: options.markdown,
      kind: selected.every((entry) => entry.kind === 'dream') ? 'dream' : 'reflection',
      source: 'compact',
      createdAt: formatBeijingIso(now),
    }
    const firstStart = Math.min(...selected.map((entry) => entry.start))
    const selectedByStart = new Map(selected.map((entry) => [entry.start, entry]))
    let cursor = 0
    let content = ''
    for (const entry of entries) {
      if (!selectedByStart.has(entry.start)) continue
      content += file.content.slice(cursor, entry.start)
      if (entry.start === firstStart) content += renderEntry(compacted)
      cursor = entry.end
    }
    content += file.content.slice(cursor)
    content = normalizedFile(content)
    await atomicWrite(file.path, content)
    return {
      path: file.path,
      entry: compacted,
      compactedEntryIds: options.entryIds,
      revision: revisionOf(content),
    }
  })
}

export async function ensureLifeAgenda(options: LifeJournalStoreOptions): Promise<string> {
  return withCoordinatedWrite(options, AGENDA_RESOURCE_KEY, () => ensureLifeAgendaUnlocked(options))
}

async function ensureLifeAgendaUnlocked(options: LifeJournalStoreOptions): Promise<string> {
  const path = agendaPath(options.rootDir)
  await mkdir(lifeDir(options.rootDir), { recursive: true })
  try {
    await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(path, AGENDA_TEMPLATE, 'utf8')
  }
  return path
}

export async function readLifeAgenda(options: LifeJournalStoreOptions): Promise<string> {
  await ensureLifeAgenda(options)
  return readFile(agendaPath(options.rootDir), 'utf8')
}

export async function readLifeAgendaSnapshot(
  options: LifeJournalStoreOptions,
): Promise<{ markdown: string; revision: string }> {
  const markdown = await readLifeAgenda(options)
  return { markdown, revision: revisionOf(markdown) }
}

export async function writeLifeAgenda(options: LifeJournalStoreOptions, markdown: string): Promise<void> {
  await withCoordinatedWrite(options, AGENDA_RESOURCE_KEY, () => writeLifeAgendaUnlocked(options, markdown))
}

async function writeLifeAgendaUnlocked(options: LifeJournalStoreOptions, markdown: string): Promise<void> {
  await mkdir(lifeDir(options.rootDir), { recursive: true })
  await atomicWrite(agendaPath(options.rootDir), markdown)
}

export async function writeLifeAgendaIfRevision(
  options: LifeJournalStoreOptions & { expectedRevision: string },
  markdown: string,
): Promise<{ revision: string }> {
  return withCoordinatedWrite(options, AGENDA_RESOURCE_KEY, async () => {
    await ensureLifeAgendaUnlocked(options)
    const current = await readFile(agendaPath(options.rootDir), 'utf8')
    assertRevision(current, options.expectedRevision)
    await writeLifeAgendaUnlocked(options, markdown)
    return { revision: revisionOf(markdown) }
  })
}

export async function readRecentLifeJournalFiles(
  options: LifeJournalStoreOptions & { days: number },
): Promise<LifeJournalFile[]> {
  let names: string[]
  try {
    names = await readdir(journalDir(options.rootDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }

  const dailyNames = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort((a, b) => b.localeCompare(a))

  const files: LifeJournalFile[] = []
  for (const name of dailyNames) {
    if (files.length >= Math.max(0, options.days)) break
    try {
      files.push(await readJournalFile(options.rootDir, name.slice(0, -3)))
    } catch (error) {
      if (!(error instanceof LifeJournalStoreError) || error.code !== 'invalid_format') throw error
    }
  }
  return files
}
