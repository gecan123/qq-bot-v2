import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { readLifeJournalDay } from '../agent/life-journal-store.js'
import { inspectMemoryFileForMaintenance, type MemoryEntry } from '../agent/memory-store.js'

type StoreName = 'memory' | 'notebook' | 'lifeJournal'

export interface AgentMemoryCheckReport {
  ok: boolean
  root: string
  counts: Record<StoreName, { files: number; entries: number }>
  lifecycle: {
    expired: number
    disputed: number
    superseded: number
    stableWithoutSources: number
  }
  issues: {
    corruptOrUnsupportedFiles: string[]
    duplicateIds: Array<{ id: string; locations: string[] }>
    selfReferencingSupersedes: Array<{ id: string; location: string }>
    unknownSupersedes: Array<{ id: string; targetId: string; location: string }>
  }
  agenda: {
    exists: boolean
    revision: string | null
    sizeBytes: number
  }
}

interface LocatedEntry {
  id: string
  location: string
}

interface NotebookCheckEntry extends LocatedEntry {}

export async function checkAgentMemory(options: {
  rootDir: string
  now?: Date
}): Promise<AgentMemoryCheckReport> {
  const rootDir = resolve(options.rootDir)
  const nowMs = (options.now ?? new Date()).getTime()
  const corruptOrUnsupportedFiles: string[] = []
  const selfReferencingSupersedes: Array<{ id: string; location: string }> = []
  const unknownSupersedes: Array<{ id: string; targetId: string; location: string }> = []
  const locatedEntries: LocatedEntry[] = []
  const parsedMemoryEntries: Array<{ entry: MemoryEntry; location: string }> = []

  const memoryRoot = join(rootDir, 'memory')
  const memoryFiles = await listMarkdownFiles(memoryRoot)
  for (const file of memoryFiles) {
    const location = `memory/${file}`
    const raw = await readFile(join(memoryRoot, file), 'utf8')
    selfReferencingSupersedes.push(...scanSelfReferences(raw, location))
    try {
      const snapshot = await inspectMemoryFileForMaintenance({ rootDir }, file)
      for (const entry of snapshot.entries) {
        const entryLocation = `${location}#${entry.id}`
        parsedMemoryEntries.push({ entry, location: entryLocation })
        locatedEntries.push({ id: entry.id, location: entryLocation })
      }
    } catch {
      corruptOrUnsupportedFiles.push(location)
    }
  }

  const memoryIds = new Set(parsedMemoryEntries.map(({ entry }) => entry.id))
  for (const { entry, location } of parsedMemoryEntries) {
    for (const targetId of entry.supersedes) {
      if (!memoryIds.has(targetId)) unknownSupersedes.push({ id: entry.id, targetId, location })
    }
  }

  const notebookRoot = join(rootDir, 'notebook')
  const notebookFiles = await listMarkdownFiles(notebookRoot)
  const notebookEntries: NotebookCheckEntry[] = []
  for (const file of notebookFiles) {
    const location = `notebook/${file}`
    const raw = await readFile(join(notebookRoot, file), 'utf8')
    const parsed = parseNotebookFile(raw, file, location)
    if (!parsed) {
      corruptOrUnsupportedFiles.push(location)
      continue
    }
    notebookEntries.push(...parsed)
    locatedEntries.push(...parsed)
  }

  const journalRoot = join(rootDir, 'life', 'journal')
  const journalFiles = await listMarkdownFiles(journalRoot)
  let lifeJournalEntries = 0
  for (const file of journalFiles) {
    const location = `life/journal/${file}`
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file)
    if (!match || file.includes('/')) {
      corruptOrUnsupportedFiles.push(location)
      continue
    }
    try {
      const journal = await readLifeJournalDay({ rootDir, date: match[1]! })
      lifeJournalEntries += journal.entries.length
      for (const entry of journal.entries) {
        locatedEntries.push({ id: entry.id, location: `${location}#${entry.id}` })
      }
    } catch {
      corruptOrUnsupportedFiles.push(location)
    }
  }

  const agenda = await inspectAgenda(rootDir)
  const duplicateIds = duplicateEntryIds(locatedEntries)
  const lifecycle = {
    expired: parsedMemoryEntries.filter(({ entry }) => entry.validUntil != null && Date.parse(entry.validUntil) < nowMs).length,
    disputed: parsedMemoryEntries.filter(({ entry }) => entry.status === 'disputed').length,
    superseded: parsedMemoryEntries.filter(({ entry }) => entry.status === 'superseded').length,
    stableWithoutSources: parsedMemoryEntries.filter(({ entry }) => entry.tier === 'stable' && entry.sourceMessageIds.length === 0).length,
  }
  const issues = {
    corruptOrUnsupportedFiles: [...new Set(corruptOrUnsupportedFiles)].sort(),
    duplicateIds,
    selfReferencingSupersedes: selfReferencingSupersedes.sort(compareIssue),
    unknownSupersedes: unknownSupersedes.sort(compareIssue),
  }
  const ok = issues.corruptOrUnsupportedFiles.length === 0
    && issues.duplicateIds.length === 0
    && issues.selfReferencingSupersedes.length === 0
    && issues.unknownSupersedes.length === 0

  return {
    ok,
    root: rootDir,
    counts: {
      memory: { files: memoryFiles.length, entries: parsedMemoryEntries.length },
      notebook: { files: notebookFiles.length, entries: notebookEntries.length },
      lifeJournal: { files: journalFiles.length, entries: lifeJournalEntries },
    },
    lifecycle,
    issues,
    agenda,
  }
}

export function memoryCheckExitCode(report: AgentMemoryCheckReport): 0 | 1 {
  return report.ok ? 0 : 1
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relative(root, path).replace(/\\/g, '/'))
      }
    }
  }
  await walk(root)
  return files.sort()
}

function scanSelfReferences(raw: string, location: string): Array<{ id: string; location: string }> {
  const issues: Array<{ id: string; location: string }> = []
  for (const match of raw.matchAll(/<!-- memory-entry([\s\S]*?)-->/g)) {
    const metadata = match[1] ?? ''
    const id = /^id:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const supersedesRaw = /^supersedes:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    if (!id || !supersedesRaw) continue
    try {
      const supersedes = JSON.parse(supersedesRaw) as unknown
      if (Array.isArray(supersedes) && supersedes.includes(id)) issues.push({ id, location: `${location}#${id}` })
    } catch {
      // The store parser reports malformed JSON as a corrupt file.
    }
  }
  return issues
}

function parseNotebookFile(raw: string, file: string, location: string): NotebookCheckEntry[] | null {
  const [kind, name, ...rest] = file.split('/')
  if (rest.length > 0 || !kind || !name || !['research', 'reading', 'market', 'project', 'general'].includes(kind)) {
    return null
  }
  const month = /^(\d{4}-\d{2})\.md$/.exec(name)?.[1]
  const expectedHeading = month ? `# ${kind[0]!.toUpperCase()}${kind.slice(1)} Notebook ${month}` : null
  if (!expectedHeading || !raw.startsWith(`${expectedHeading}\n`)) return null

  const entries: NotebookCheckEntry[] = []
  let offset = 0
  let markers = 0
  while (offset < raw.length) {
    const start = raw.indexOf('<!-- notebook-entry', offset)
    if (start < 0) break
    markers++
    const metaEnd = raw.indexOf('-->', start)
    const close = metaEnd < 0 ? -1 : raw.indexOf('<!-- /notebook-entry -->', metaEnd + 3)
    if (metaEnd < 0 || close < 0) return null
    const metadata = raw.slice(start + '<!-- notebook-entry'.length, metaEnd)
    const id = /^id:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const entryKind = /^kind:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const topic = /^topic:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const createdAt = /^createdAt:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const content = raw.slice(metaEnd + 3, close).trim()
    if (!id || entryKind !== kind || !topic || !createdAt || !content) return null
    entries.push({ id, location: `${location}#${id}` })
    offset = close + '<!-- /notebook-entry -->'.length
  }
  return entries.length === markers ? entries : null
}

async function inspectAgenda(rootDir: string): Promise<AgentMemoryCheckReport['agenda']> {
  let markdown: string
  try {
    markdown = await readFile(join(rootDir, 'life', 'agenda.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, revision: null, sizeBytes: 0 }
    }
    throw error
  }
  return {
    exists: true,
    revision: createHash('sha256').update(markdown).digest('hex'),
    sizeBytes: Buffer.byteLength(markdown, 'utf8'),
  }
}

function duplicateEntryIds(entries: LocatedEntry[]): AgentMemoryCheckReport['issues']['duplicateIds'] {
  const locations = new Map<string, string[]>()
  for (const entry of entries) {
    const current = locations.get(entry.id) ?? []
    current.push(entry.location)
    locations.set(entry.id, current)
  }
  return [...locations]
    .filter(([, values]) => values.length > 1)
    .map(([id, values]) => ({ id, locations: values.sort() }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function compareIssue(
  left: { id: string; location: string },
  right: { id: string; location: string },
): number {
  return left.location.localeCompare(right.location) || left.id.localeCompare(right.id)
}
