import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  inspectMemoryFileForMaintenance,
  listMemoryFiles,
  SELF_MEMORY_FILE,
  TOPIC_MEMORY_FILE,
  type MemoryEntry,
} from '../agent/memory-store.js'
import { withOperationBackup } from './operation-backup-error.js'

interface CanonicalDocument {
  file: typeof SELF_MEMORY_FILE | typeof TOPIC_MEMORY_FILE
  scope: 'self' | 'topic'
  title: string
  updatedAt: string
  entries: MemoryEntry[]
}

export interface MemoryCanonicalizationResult {
  ok: true
  applied: boolean
  needed: boolean
  backupDir?: string
  filesBefore: number
  filesAfter: number
  entries: number
  consolidatedFiles: number
  sourceFiles: string[]
  targets: string[]
  stateFingerprint: string
}

export async function canonicalizeSelfTopicMemory(input: {
  rootDir: string
  apply?: boolean
  now?: () => Date
}): Promise<MemoryCanonicalizationResult> {
  const rootDir = resolve(input.rootDir)
  const listed = await listMemoryFiles({ rootDir }, { limit: 100 })
  if (listed.truncated) throw new Error('memory canonicalization supports at most 100 files per run')
  if (listed.skippedCorrupt > 0) {
    throw new Error(`memory canonicalization found ${listed.skippedCorrupt} corrupt files`)
  }

  const documents = new Map<'self' | 'topic', CanonicalDocument>()
  const seenIds = new Map<string, string>()
  const sourceFiles: string[] = []
  const rawFiles = new Map<string, string>()
  let entries = 0

  for (const file of listed.files) {
    const snapshot = await inspectMemoryFileForMaintenance({ rootDir }, file.file)
    if (snapshot.entriesTruncated) {
      throw new Error(`memory canonicalization supports at most 500 entries per file: ${file.file}`)
    }
    entries += snapshot.entries.length
    if (file.scope !== 'self' && file.scope !== 'topic') continue
    sourceFiles.push(file.file)
    rawFiles.set(file.file, await readFile(join(rootDir, 'memory', file.file), 'utf8'))
    const target = canonicalTarget(file.scope)
    const document = documents.get(file.scope) ?? {
      file: target.file,
      scope: file.scope,
      title: target.title,
      updatedAt: file.updatedAt ?? latestEntryTimestamp(snapshot.entries),
      entries: [],
    }
    document.updatedAt = latestTimestamp(
      document.updatedAt,
      file.updatedAt ?? latestEntryTimestamp(snapshot.entries),
    )
    for (const entry of snapshot.entries) {
      const previousFile = seenIds.get(entry.id)
      if (previousFile) {
        throw new Error(`memory canonicalization entry id collision: ${entry.id} in ${previousFile} and ${file.file}`)
      }
      seenIds.set(entry.id, file.file)
      document.entries.push({
        ...entry,
        aliases: file.title === target.title
          ? entry.aliases
          : [...new Set([...entry.aliases, file.title])],
      })
    }
    documents.set(file.scope, document)
  }

  for (const document of documents.values()) {
    document.entries.sort((left, right) => (
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
    ))
  }

  const planned = [...documents.values()].sort((left, right) => left.file.localeCompare(right.file))
  const rendered = planned.map(document => ({ file: document.file, content: renderDocument(document) }))
  const sortedSourceFiles = [...sourceFiles].sort()
  const rawSources = sortedSourceFiles.map(file => ({ file, content: rawFiles.get(file) }))
  const needed = sortedSourceFiles.length !== rendered.length
    || rendered.some(document => rawFiles.get(document.file) !== document.content)
  const resultBase = {
    ok: true as const,
    applied: input.apply === true,
    needed,
    filesBefore: listed.total,
    filesAfter: listed.total - sourceFiles.length + planned.length,
    entries,
    consolidatedFiles: sourceFiles.length,
    sourceFiles: sourceFiles.sort(),
    targets: planned.map((document) => document.file),
    stateFingerprint: createHash('sha256')
      .update(JSON.stringify({ rawSources, rendered }))
      .digest('hex'),
  }
  if (!input.apply) return resultBase

  const now = input.now?.() ?? new Date()
  const backupDir = join(rootDir, 'db-backups', `memory-canonical-${backupStamp(now)}`)
  const memoryDir = join(rootDir, 'memory')
  const token = randomUUID()
  const tempRoot = join(rootDir, `.memory-canonical-build-${token}`)
  const tempMemoryDir = join(tempRoot, 'memory')
  const displaced = join(rootDir, `.memory-canonical-displaced-${token}`)

  await mkdir(backupDir, { recursive: true })
  await cp(memoryDir, join(backupDir, 'memory'), { recursive: true })
  try {
    await cp(memoryDir, tempMemoryDir, { recursive: true })
    for (const file of sourceFiles) await rm(join(tempMemoryDir, file), { force: true })
    for (const document of planned) {
      const path = join(tempMemoryDir, document.file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, renderDocument(document), 'utf8')
    }

    const validationFiles = [
      ...listed.files
        .map((file) => file.file)
        .filter((file) => !sourceFiles.includes(file)),
      ...planned.map((document) => document.file),
    ]
    for (const file of validationFiles) await inspectMemoryFileForMaintenance({ rootDir: tempRoot }, file)

    await rename(memoryDir, displaced)
    try {
      await rename(tempMemoryDir, memoryDir)
    } catch (error) {
      await rename(displaced, memoryDir)
      throw error
    }
    await rm(displaced, { recursive: true, force: true })
  } catch (error) {
    throw withOperationBackup(error, backupDir)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  return { ...resultBase, backupDir }
}

function canonicalTarget(scope: 'self' | 'topic'): {
  file: typeof SELF_MEMORY_FILE | typeof TOPIC_MEMORY_FILE
  title: string
} {
  return scope === 'self'
    ? { file: SELF_MEMORY_FILE, title: '自我记忆' }
    : { file: TOPIC_MEMORY_FILE, title: '主题记忆' }
}

function latestEntryTimestamp(entries: readonly MemoryEntry[]): string {
  return entries.reduce(
    (latest, entry) => latestTimestamp(latest, entry.updatedAt),
    '1970-01-01T08:00:00.000+08:00',
  )
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function renderDocument(document: CanonicalDocument): string {
  const stable = document.entries.filter((entry) => entry.tier === 'stable').map(renderEntry).join('')
  const recent = document.entries.filter((entry) => entry.tier === 'recent').map(renderEntry).join('')
  const lines = [
    '---',
    'formatVersion: 2',
    `scope: ${document.scope}`,
    `title: ${document.title}`,
    `updatedAt: ${document.updatedAt}`,
    'aliases: []',
    '---',
    '',
    '## 稳定记忆',
    '',
  ]
  if (stable) lines.push(stable.trimEnd(), '')
  lines.push('## 最近线索', '')
  if (recent) lines.push(recent.trimEnd(), '')
  return `${lines.join('\n').trimEnd()}\n`
}

function renderEntry(entry: MemoryEntry): string {
  return [
    '<!-- memory-entry',
    `id: ${entry.id}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    `tier: ${entry.tier}`,
    `status: ${entry.status}`,
    `aliases: ${JSON.stringify(entry.aliases)}`,
    ...(entry.validUntil ? [`validUntil: ${entry.validUntil}`] : []),
    `supersedes: ${JSON.stringify(entry.supersedes)}`,
    ...(entry.sourceMessageIds.length > 0 ? [`sourceMessageIds: ${entry.sourceMessageIds.join(',')}`] : []),
    ...(entry.assertedByIds.length > 0 ? [`assertedByIds: ${entry.assertedByIds.join(',')}`] : []),
    ...(entry.evidenceKind ? [`evidenceKind: ${entry.evidenceKind}`] : []),
    ...(entry.memoryKind ? [`memoryKind: ${entry.memoryKind}`] : []),
    '-->',
    `- ${entry.content}`,
    '<!-- /memory-entry -->',
    '',
  ].join('\n')
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
