import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  inspectMemoryFileForMaintenance,
  listMemoryFiles,
  readMemoryFile,
  type MemoryContext,
  type MemoryEntry,
  type MemoryEvidenceKind,
  type MemoryKind,
  type MemoryScope,
} from '../agent/memory-store.js'
import { deriveMemoryEvidence, type LoadMemorySourceEvidence } from '../agent/memory-evidence.js'

interface MigrationDocument {
  file: string
  scope: MemoryScope
  entityId?: string
  title: string
  aliases: string[]
  context?: MemoryContext
  updatedAt: string
  entries: MemoryEntry[]
}

export interface MemoryV2MigrationChange {
  from: string
  to: string
  entryId: string
  reason: 'format_upgrade' | 'person_quarantine' | 'person_extracted_from_group'
}

export interface MemoryV2MigrationResult {
  ok: true
  applied: boolean
  needed: boolean
  backupDir?: string
  filesBefore: number
  filesAfter: number
  entries: number
  movedPersonEntries: number
  quarantinedPersonEntries: number
  changes: MemoryV2MigrationChange[]
  warnings: string[]
}

export async function migrateMemoryToV2(input: {
  rootDir: string
  apply?: boolean
  now?: () => Date
  loadSourceEvidence?: LoadMemorySourceEvidence
}): Promise<MemoryV2MigrationResult> {
  const rootDir = resolve(input.rootDir)
  const listed = await listMemoryFiles({ rootDir }, { limit: 100 })
  if (listed.truncated) throw new Error('memory v2 migration supports at most 100 files per run')
  if (listed.skippedCorrupt > 0) throw new Error(`memory v2 migration found ${listed.skippedCorrupt} corrupt files`)

  const documents = new Map<string, MigrationDocument>()
  const warnings: string[] = []
  const changes: MemoryV2MigrationChange[] = []
  let movedPersonEntries = 0
  let quarantinedPersonEntries = 0
  let needed = false

  for (const file of listed.files) {
    const read = await readMemoryFile({ rootDir }, { file: file.file, maxChars: 12_000 })
    if (!read.ok) throw new Error(`memory v2 migration cannot read ${file.file}: ${read.error}`)
    if (read.entriesTruncated) throw new Error(`memory v2 migration supports at most 50 entries per file: ${file.file}`)
    const raw = await readFile(join(rootDir, 'memory', file.file), 'utf8')
    if (!/^formatVersion:\s*2\s*$/m.test(raw)) needed = true
    const aliases = parseFrontmatterAliases(raw)
    const entityId = file.scope === 'person' || file.scope === 'group'
      ? entityIdFromFile(file.file, file.scope)
      : undefined

    for (const originalEntry of read.entries) {
      let destination = file.file
      let scope = file.scope
      let context = file.context
      let title = file.title
      let reason: MemoryV2MigrationChange['reason'] = 'format_upgrade'

      if (file.scope === 'person' && !file.context) {
        destination = `people/${entityId!}/unscoped.md`
        context = { kind: 'legacy_unscoped' }
        reason = 'person_quarantine'
        quarantinedPersonEntries += 1
        needed = true
      } else if (file.scope === 'group') {
        const personId = explicitPersonId(originalEntry.content)
        if (personId) {
          destination = `people/${personId}/groups/${entityId!}.md`
          scope = 'person'
          context = { kind: 'qq_group', id: entityId! }
          title = personId
          reason = 'person_extracted_from_group'
          movedPersonEntries += 1
          needed = true
        }
      }

      const entry = await migrateEntry({
        entry: originalEntry,
        sourceFile: file.file,
        destinationScope: scope,
        context,
        ownerId: undefined,
        loadSourceEvidence: input.loadSourceEvidence,
        warnings,
        quarantine: reason === 'person_quarantine',
        extractedFromGroup: reason === 'person_extracted_from_group',
        subjectId: scope === 'person' ? entityIdFromFile(destination, 'person') : undefined,
      })
      addDocumentEntry(documents, {
        file: destination,
        scope,
        ...(scope === 'person' || scope === 'group' ? { entityId: entityIdFromFile(destination, scope) } : {}),
        title,
        aliases: destination === file.file ? aliases : [],
        ...(context ? { context } : {}),
        updatedAt: file.updatedAt ?? entry.updatedAt,
        entries: [entry],
      })
      changes.push({ from: file.file, to: destination, entryId: entry.id, reason })
    }

    if (read.entries.length === 0) {
      addDocumentEntry(documents, {
        file: file.scope === 'person' && !file.context ? `people/${entityId!}/unscoped.md` : file.file,
        scope: file.scope,
        ...(entityId ? { entityId } : {}),
        title: file.title,
        aliases,
        ...(file.scope === 'person' && !file.context
          ? { context: { kind: 'legacy_unscoped' } as const }
          : file.context ? { context: file.context } : {}),
        updatedAt: file.updatedAt ?? new Date(0).toISOString(),
        entries: [],
      })
    }
  }

  const planned = [...documents.values()].sort((a, b) => a.file.localeCompare(b.file))
  const resultBase = {
    ok: true as const,
    applied: input.apply === true,
    needed,
    filesBefore: listed.total,
    filesAfter: planned.length,
    entries: planned.reduce((sum, document) => sum + document.entries.length, 0),
    movedPersonEntries,
    quarantinedPersonEntries,
    changes,
    warnings,
  }
  if (!input.apply) return resultBase

  const now = input.now?.() ?? new Date()
  const backupDir = join(rootDir, 'db-backups', `memory-v2-${backupStamp(now)}`)
  const memoryDir = join(rootDir, 'memory')
  await mkdir(backupDir, { recursive: true })
  await cp(memoryDir, join(backupDir, 'memory'), { recursive: true })

  const token = randomUUID()
  const tempRoot = join(rootDir, `.memory-v2-build-${token}`)
  const displaced = join(rootDir, `.memory-v1-displaced-${token}`)
  try {
    for (const document of planned) {
      const path = join(tempRoot, 'memory', document.file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, renderDocument(document), 'utf8')
    }
    for (const document of planned) {
      await inspectMemoryFileForMaintenance({ rootDir: tempRoot }, document.file)
    }
    await rename(memoryDir, displaced)
    try {
      await rename(join(tempRoot, 'memory'), memoryDir)
    } catch (error) {
      await rename(displaced, memoryDir)
      throw error
    }
    await rm(displaced, { recursive: true, force: true })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  return { ...resultBase, backupDir }
}

async function migrateEntry(input: {
  entry: MemoryEntry
  sourceFile: string
  destinationScope: MemoryScope
  context?: MemoryContext
  ownerId?: string
  loadSourceEvidence?: LoadMemorySourceEvidence
  warnings: string[]
  quarantine: boolean
  extractedFromGroup: boolean
  subjectId?: string
}): Promise<MemoryEntry> {
  let assertedByIds = input.entry.assertedByIds
  let evidenceKind = input.entry.evidenceKind
  if (input.entry.sourceMessageIds.length > 0 && input.loadSourceEvidence) {
    const rows = await input.loadSourceEvidence(input.entry.sourceMessageIds)
    const found = new Set(rows.map((row) => row.rowId))
    const missing = input.entry.sourceMessageIds.filter((id) => !found.has(id))
    if (missing.length > 0) input.warnings.push(`${input.sourceFile}#${input.entry.id}: missing Message rows ${missing.join(',')}`)
    if (rows.length > 0) {
      try {
        const requestedKind = requestedEvidenceKind(input.destinationScope, classifyMemoryKind(
          input.destinationScope,
          input.entry.content,
        ))
        const derived = deriveMemoryEvidence({
          rows,
          ...(input.subjectId ? { subjectId: input.subjectId } : {}),
          ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          ...(requestedKind ? { requestedKind } : {}),
        })
        assertedByIds = assertedByIds.length > 0 ? assertedByIds : derived.assertedByIds
        evidenceKind = evidenceKind ?? derived.evidenceKind
        if (input.context && input.context.kind !== 'legacy_unscoped'
          && input.context.kind !== 'core'
          && (derived.context.kind !== input.context.kind || derived.context.id !== input.context.id)) {
          input.warnings.push(`${input.sourceFile}#${input.entry.id}: evidence context differs from destination`)
        }
      } catch (error) {
        input.warnings.push(`${input.sourceFile}#${input.entry.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (!evidenceKind) evidenceKind = 'legacy_unverified'
  const memoryKind = input.entry.memoryKind ?? classifyMemoryKind(input.destinationScope, input.entry.content)
  const shouldDispute = (input.quarantine || input.extractedFromGroup)
    && input.entry.status !== 'superseded'
    && evidenceKind === 'legacy_unverified'
  return {
    ...input.entry,
    assertedByIds,
    evidenceKind,
    ...(memoryKind ? { memoryKind } : {}),
    status: shouldDispute ? 'disputed' : input.entry.status,
  }
}

function requestedEvidenceKind(scope: MemoryScope, kind: MemoryKind | undefined): MemoryEvidenceKind | undefined {
  if (scope !== 'group') return undefined
  if (kind === 'group_rule') return 'explicit_rule'
  if (kind === 'group_rhythm' || kind === 'group_culture' || kind === 'group_structure') return 'observed_pattern'
  return undefined
}

function classifyMemoryKind(scope: MemoryScope, content: string): MemoryKind | undefined {
  if (scope === 'person') {
    if (/职业|公务员|程序员|身份|创造者|QQ\s*\d+/i.test(content)) return 'person_identity'
    if (/喜欢|偏好|兴趣|不希望/.test(content)) return 'person_preference'
    if (/关系|群友|朋友|主人/.test(content)) return 'person_relationship'
    return 'person_behavior'
  }
  if (scope !== 'group') return undefined
  if (/允许|不允许|禁止|规则|只允许|约定/.test(content)) return 'group_rule'
  if (/活跃|时段|深夜|清晨|白天|节奏|高峰|周期/.test(content)) return 'group_rhythm'
  if (/成员|群友|核心|结构/.test(content)) return 'group_structure'
  if (/话题|讨论|游戏|动漫/.test(content)) return 'group_topic'
  if (/历史|曾经|成立|改名/.test(content)) return 'group_history'
  return 'group_culture'
}

function explicitPersonId(content: string): string | null {
  return /(?:QQ|qq)\s*[:：#]?\s*(\d{5,12})/.exec(content)?.[1] ?? null
}

function entityIdFromFile(file: string, scope: MemoryScope): string {
  const match = scope === 'person' ? /^people\/([^/]+)/.exec(file) : /^groups\/([^/]+)\.md$/.exec(file)
  if (!match) throw new Error(`cannot derive ${scope} entity id from memory file: ${file}`)
  return scope === 'person' ? match[1]!.replace(/\.md$/, '') : match[1]!
}

function addDocumentEntry(documents: Map<string, MigrationDocument>, incoming: MigrationDocument): void {
  const existing = documents.get(incoming.file)
  if (!existing) {
    documents.set(incoming.file, incoming)
    return
  }
  if (existing.scope !== incoming.scope || JSON.stringify(existing.context) !== JSON.stringify(incoming.context)) {
    throw new Error(`memory v2 migration destination collision: ${incoming.file}`)
  }
  for (const entry of incoming.entries) {
    const duplicate = existing.entries.find((candidate) => candidate.id === entry.id)
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(entry)) {
      throw new Error(`memory v2 migration entry id collision: ${entry.id}`)
    }
    if (!duplicate) existing.entries.push(entry)
  }
  existing.updatedAt = latestTimestamp(existing.updatedAt, incoming.updatedAt)
  existing.aliases = [...new Set([...existing.aliases, ...incoming.aliases])]
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function parseFrontmatterAliases(raw: string): string[] {
  const value = /^aliases:\s*(.+)$/m.exec(raw)?.[1]
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

function renderDocument(document: MigrationDocument): string {
  const stable = document.entries.filter((entry) => entry.tier === 'stable').map(renderEntry).join('')
  const recent = document.entries.filter((entry) => entry.tier === 'recent').map(renderEntry).join('')
  const lines = [
    '---',
    'formatVersion: 2',
    `scope: ${document.scope}`,
    ...(document.entityId ? [`entityId: ${document.entityId}`] : []),
    ...(document.context ? [`contextKind: ${document.context.kind}`] : []),
    ...(document.context && (document.context.kind === 'qq_group' || document.context.kind === 'qq_private')
      ? [`contextId: ${document.context.id}`]
      : []),
    `title: ${document.title}`,
    `updatedAt: ${document.updatedAt}`,
    `aliases: ${JSON.stringify(document.aliases)}`,
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
