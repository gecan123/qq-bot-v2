import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import { compareTimestampsDesc, formatBeijingCompact, formatBeijingIso } from '../utils/beijing-time.js'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

export type MemoryScope = 'self' | 'person' | 'group' | 'topic'
export type MemoryTier = 'recent' | 'stable'
export type MemoryStatus = 'active' | 'disputed' | 'superseded'
export type MemoryContext =
  | { kind: 'core' }
  | { kind: 'qq_group'; id: string }
  | { kind: 'qq_private'; id: string }
  | { kind: 'legacy_unscoped' }
export type ConversationMemoryContext =
  | { kind: 'qq_group'; id: string }
  | { kind: 'qq_private'; id: string }
export type MemoryEvidenceKind =
  | 'self_report'
  | 'owner_assertion'
  | 'third_party_report'
  | 'observed_pattern'
  | 'explicit_rule'
  | 'legacy_unverified'
export type MemoryKind =
  | 'person_identity'
  | 'person_preference'
  | 'person_behavior'
  | 'person_relationship'
  | 'group_rule'
  | 'group_rhythm'
  | 'group_topic'
  | 'group_culture'
  | 'group_history'
  | 'group_structure'

export const SELF_MEMORY_FILE = 'self/self.md'
export const TOPIC_MEMORY_FILE = 'topics/topics.md'

export interface MemoryStoreOptions {
  rootDir: string
  now?: () => Date
  id?: () => string
  maxReadChars?: number
  maxSnippetChars?: number
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

export interface WriteMemoryInput {
  scope: MemoryScope
  id?: string
  context?: MemoryContext
  title?: string
  content: string
  sourceMessageIds?: number[]
  assertedByIds?: string[]
  evidenceKind?: MemoryEvidenceKind
  memoryKind?: MemoryKind
}

export interface SearchMemoryInput {
  keyword?: string
  scope?: MemoryScope
  limit?: number
}

export interface RecallMemoryInput {
  query: string
  scope?: MemoryScope
  id?: string
  context?: ConversationMemoryContext
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
  context?: MemoryContext
  entryId: string
  tier: MemoryTier
  created: boolean
  deduplicated: boolean
  changed: boolean
  revision: string
}

export interface MemoryEntry {
  id: string
  createdAt: string
  updatedAt: string
  content: string
  sourceMessageIds: number[]
  assertedByIds: string[]
  evidenceKind?: MemoryEvidenceKind
  memoryKind?: MemoryKind
  tier: MemoryTier
  status: MemoryStatus
  aliases: string[]
  validUntil?: string
  supersedes: string[]
}

export type MemoryMaintenanceOperation =
  | { action: 'promote'; entryId: string; content: string }
  | { action: 'merge'; entryIds: string[]; content: string }
  | { action: 'mark_disputed'; entryIds: string[]; reason: string }
  | { action: 'discard'; entryId: string; reason: string }

export interface MemoryMaintenanceSnapshot {
  ok: true
  file: string
  scope: MemoryScope
  title: string
  context?: MemoryContext
  revision: string
  sizeBytes: number
  entries: MemoryEntry[]
  entriesTruncated: boolean
  recentCount: number
  stableCount: number
  recentChars: number
}

export interface MemorySearchMatch {
  file: string
  scope: MemoryScope
  title: string
  context?: MemoryContext
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
    revision: string
    scope: MemoryScope
    title: string
    updatedAt: string | null
    entryId: string
    createdAt: string
    content: string
    sourceMessageIds: number[]
    assertedByIds: string[]
    evidenceKind?: MemoryEvidenceKind
    memoryKind?: MemoryKind
    context?: MemoryContext
    tier: MemoryTier
    status: MemoryStatus
    aliases: string[]
    validUntil?: string
    score: number
    matchedTerms: string[]
    scoreReasons: string[]
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
    context?: MemoryContext
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
    readonly code: 'not_found' | 'revision_conflict' | 'invalid_input' | 'invalid_selection' | 'invalid_format',
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
const MIN_RECALL_SCORE = 20
const ENTRY_START = '<!-- memory-entry'
const ENTRY_END = '<!-- /memory-entry -->'

function withCoordinatedWrite<T>(
  options: MemoryStoreOptions,
  resourceKey: string,
  task: () => Promise<T>,
): Promise<T> {
  return options.workspaceStateCoordinator
    ? options.workspaceStateCoordinator.withWrite(resourceKey, task)
    : task()
}

export async function writeMemoryEntry(
  options: MemoryStoreOptions,
  input: WriteMemoryInput,
): Promise<MemoryWriteResult> {
  const title = titleForInput(input)
  const relativeFile = fileForInput(input)
  const write = async (): Promise<MemoryWriteResult> => {
    const now = options.now?.() ?? new Date()
    const nowIso = formatBeijingIso(now)
    const absoluteFile = safeMemoryFile(options.rootDir, relativeFile)
    await mkdir(dirname(absoluteFile), { recursive: true })

    const existing = await readOptional(absoluteFile)
    if (existing && parseMarkdownMemory(existing)) parseMemoryEntries(existing)
    const base = existing && parseMarkdownMemory(existing)
      ? existing
      : renderNewFile(input, documentTitleForInput(input), nowIso)
    const entries = parseMemoryEntries(base)
    const normalizedContent = normalizeSearchText(input.content)
    const inputAliases = aliasesForInput(input, title)
    const duplicate = entries.find((entry) => normalizeSearchText(entry.content) === normalizedContent)
    if (duplicate) {
      const sourceMessageIds = [...new Set([
        ...duplicate.sourceMessageIds,
        ...(input.sourceMessageIds ?? []),
      ])]
      const assertedByIds = [...new Set([
        ...duplicate.assertedByIds,
        ...(input.assertedByIds ?? []),
      ])]
      const aliases = [...new Set([...duplicate.aliases, ...inputAliases])]
      const duplicateEntries = entries.map((entry) => entry.id === duplicate.id
        ? {
            ...entry,
            updatedAt: nowIso,
            sourceMessageIds,
            assertedByIds,
            aliases,
            evidenceKind: entry.evidenceKind ?? input.evidenceKind,
            memoryKind: entry.memoryKind ?? input.memoryKind,
          }
        : entry)
      const deduplicatedRaw = sourceMessageIds.length === duplicate.sourceMessageIds.length
        && assertedByIds.length === duplicate.assertedByIds.length
        && aliases.length === duplicate.aliases.length
        && (duplicate.evidenceKind != null || input.evidenceKind == null)
        && (duplicate.memoryKind != null || input.memoryKind == null)
        ? base
        : renderManagedMemory(base, duplicateEntries, nowIso)
      if (deduplicatedRaw !== base) await atomicWrite(absoluteFile, deduplicatedRaw)
      return {
        ok: true,
        file: relativeFile,
        scope: input.scope,
        title,
        ...(input.context ? { context: input.context } : {}),
        entryId: duplicate.id,
        tier: duplicate.tier,
        created: false,
        deduplicated: true,
        changed: deduplicatedRaw !== base,
        revision: revisionOf(deduplicatedRaw),
      }
    }

    const entryId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
    entries.push({
      id: entryId,
      createdAt: nowIso,
      updatedAt: nowIso,
      content: input.content.trim(),
      sourceMessageIds: input.sourceMessageIds ?? [],
      assertedByIds: input.assertedByIds ?? [],
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      ...(input.memoryKind ? { memoryKind: input.memoryKind } : {}),
      tier: 'recent',
      status: 'active',
      aliases: inputAliases,
      supersedes: [],
      start: 0,
      end: 0,
    })
    const raw = renderManagedMemory(base, entries, nowIso)
    await atomicWrite(absoluteFile, raw)
    return {
      ok: true,
      file: relativeFile,
      scope: input.scope,
      title,
      ...(input.context ? { context: input.context } : {}),
      entryId,
      tier: 'recent',
      created: true,
      deduplicated: false,
      changed: true,
      revision: revisionOf(raw),
    }
  }

  return withCoordinatedWrite(options, `memory:${relativeFile}`, write)
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
    const parsed = parseMemoryDocument(raw)
    if (!parsed) {
      skippedCorrupt += 1
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const haystack = `${file}\n${parsed.title}\n${searchableMemoryText(parsed.entries)}`.toLocaleLowerCase()
    if (needle && !haystack.includes(needle)) continue
    matches.push({
      file,
      scope: parsed.scope,
      title: parsed.title,
      ...(parsed.context ? { context: parsed.context } : {}),
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
  const targetedFiles = filesForRecall(input)
  const query = normalizeSearchText(input.query)
  const queryTerms = recallQueryTerms(input.query)
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
  const nowMs = (options.now?.() ?? new Date()).getTime()
  const root = memoryRoot(options.rootDir)
  const files = targetedFiles ?? await listMarkdownFiles(root)
  const matches: MemoryRecallResult['matches'] = []
  let skippedCorrupt = 0

  for (const file of files) {
    const raw = await readOptional(join(root, file))
    if (raw == null) continue
    const parsed = parseMemoryDocument(raw)
    if (!parsed) {
      skippedCorrupt++
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    const titleText = normalizeSearchText(parsed.title)
    const topicText = parsed.scope === 'topic'
      ? normalizeSearchText(`${parsed.title} ${file.replace(/^topics\//, '').replace(/\.md$/, '')}`)
      : titleText
    const identity = identityFromMemoryFile(parsed.scope, file)
    for (const entry of parsed.entries) {
      if (entry.status === 'superseded') continue
      if (entry.validUntil && Date.parse(entry.validUntil) < nowMs) continue
      const contentText = normalizeSearchText(entry.content)
      const aliasTexts = entry.aliases.map(normalizeSearchText)
      const matchedTerms = queryTerms
        .filter(({ value }) => (
          contentText.includes(value)
          || topicText.includes(value)
          || aliasTexts.some((alias) => alias.includes(value))
          || identity === value
        ))
        .map(({ value }) => value)
      const exactContent = query.length > 0 && contentText.includes(query)
      const exactTitle = query.length > 0 && topicText.includes(query)
      const exactIdentity = query.length > 0 && identity === query
      const exactAlias = query.length > 0 && aliasTexts.some((alias) => alias === query)
      let score = 0
      const scoreReasons: string[] = []
      if (exactIdentity) {
        score += 200
        scoreReasons.push('id_exact')
      }
      if (exactAlias) {
        score += 180
        scoreReasons.push('alias_exact')
      }
      if (exactContent) {
        score += 100
        scoreReasons.push('content_phrase')
      }
      if (exactTitle) {
        score += 60
        scoreReasons.push(parsed.scope === 'topic' ? 'topic_phrase' : 'title_phrase')
      }

      let contentTermScore = 0
      let titleTermScore = 0
      let aliasTermScore = 0
      for (const term of queryTerms) {
        if (contentText.includes(term.value)) contentTermScore += term.weight
        if (topicText.includes(term.value)) titleTermScore += Math.max(2, Math.floor(term.weight / 2))
        if (aliasTexts.some((alias) => alias.includes(term.value))) aliasTermScore += term.weight
      }
      if (contentTermScore > 0) {
        score += contentTermScore
        scoreReasons.push('content_terms')
      }
      if (titleTermScore > 0) {
        score += titleTermScore
        scoreReasons.push(parsed.scope === 'topic' ? 'topic_terms' : 'title_terms')
      }
      if (aliasTermScore > 0) {
        score += aliasTermScore
        scoreReasons.push('alias_terms')
      }
      if (entry.tier === 'stable' && score > 0) {
        score += 5
        scoreReasons.push('tier_stable_bonus')
      }
      if (entry.status === 'disputed') {
        score -= 40
        scoreReasons.push('status_disputed_penalty')
      }
      if (score < MIN_RECALL_SCORE) continue
      matches.push({
        file,
        revision: revisionOf(raw),
        scope: parsed.scope,
        title: parsed.title,
        updatedAt: entry.updatedAt,
        entryId: entry.id,
        createdAt: entry.createdAt,
        content: entry.content,
        sourceMessageIds: entry.sourceMessageIds,
        assertedByIds: entry.assertedByIds,
        ...(entry.evidenceKind ? { evidenceKind: entry.evidenceKind } : {}),
        ...(entry.memoryKind ? { memoryKind: entry.memoryKind } : {}),
        ...(parsed.context ? { context: parsed.context } : {}),
        tier: entry.tier,
        status: entry.status,
        aliases: entry.aliases,
        ...(entry.validUntil ? { validUntil: entry.validUntil } : {}),
        score,
        matchedTerms: matchedTerms.slice(0, 20),
        scoreReasons,
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
    const parsed = parseMemoryDocument(raw)
    if (!parsed) {
      skippedCorrupt++
      continue
    }
    if (input.scope && parsed.scope !== input.scope) continue
    for (const entry of parsed.entries) {
      if (entry.status === 'superseded') continue
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
  const parsed = parseMemoryDocument(raw)
  if (!parsed) {
    return { ok: false, error: 'memory file format is not supported' }
  }

  const offset = Math.min(input.offset ?? 0, raw.length)
  const max = Math.min(input.maxChars ?? options.maxReadChars ?? DEFAULT_MAX_READ_CHARS, 12_000)
  const content = raw.slice(offset, offset + max)
  const nextOffset = offset + content.length
  const parsedEntries = parsed.entries
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
  input: {
    file: string
    entryId: string
    expectedRevision: string
    content: string
    sourceMessageIds?: number[]
    assertedByIds?: string[]
    aliases?: string[]
    evidenceKind?: MemoryEvidenceKind
    memoryKind?: MemoryKind
  },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (entries, updatedAt) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    return entries.map((entry) => entry.id === input.entryId
      ? {
          ...entry,
          updatedAt,
          content: input.content.trim(),
          sourceMessageIds: [...new Set([...entry.sourceMessageIds, ...(input.sourceMessageIds ?? [])])],
          assertedByIds: [...new Set([...entry.assertedByIds, ...(input.assertedByIds ?? [])])],
          aliases: input.aliases == null ? entry.aliases : [...new Set(input.aliases)],
          evidenceKind: input.evidenceKind ?? entry.evidenceKind,
          memoryKind: input.memoryKind ?? entry.memoryKind,
        }
      : entry)
  }, input.entryId)
}

export async function correctMemoryEntry(
  options: MemoryStoreOptions,
  input: {
    file: string
    entryId: string
    expectedRevision: string
    content: string
    sourceMessageIds?: number[]
    assertedByIds?: string[]
    evidenceKind?: MemoryEvidenceKind
    memoryKind?: MemoryKind
  },
): Promise<{
  ok: true
  file: string
  oldEntryId: string
  replacementEntryId: string
  revision: string
}> {
  const now = options.now?.() ?? new Date()
  const nowIso = formatBeijingIso(now)
  const replacementEntryId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
  if (replacementEntryId === input.entryId) {
    throw new MemoryStoreError('invalid_selection', 'replacement memory entry cannot supersede itself')
  }
  const result = await mutateMemoryFile(options, input.file, input.expectedRevision, (entries) => {
    const targetIndex = entries.findIndex((entry) => entry.id === input.entryId)
    if (targetIndex < 0) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    const target = entries[targetIndex]!
    if (target.status === 'superseded') {
      throw new MemoryStoreError('invalid_selection', `memory entry is already superseded: ${input.entryId}`)
    }
    const replacement: MemoryEntry = {
      id: replacementEntryId,
      createdAt: nowIso,
      updatedAt: nowIso,
      content: input.content.trim(),
      sourceMessageIds: [...new Set(input.sourceMessageIds ?? [])],
      assertedByIds: [...new Set(input.assertedByIds ?? [])],
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      ...(input.memoryKind ? { memoryKind: input.memoryKind } : {}),
      tier: 'recent',
      status: 'active',
      aliases: [...target.aliases],
      supersedes: [input.entryId],
    }
    return entries.flatMap((entry, index) => index === targetIndex
      ? [{ ...entry, updatedAt: nowIso, status: 'superseded' as const }, replacement]
      : [entry])
  }, replacementEntryId)
  return {
    ok: true,
    file: result.file,
    oldEntryId: input.entryId,
    replacementEntryId,
    revision: result.revision,
  }
}

export async function deleteMemoryEntry(
  options: MemoryStoreOptions,
  input: { file: string; entryId: string; expectedRevision: string },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (entries) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    const referencing = entries.find((entry) => entry.supersedes.includes(input.entryId))
    if (referencing) {
      throw new MemoryStoreError(
        'invalid_selection',
        `memory entry ${input.entryId} is referenced by ${referencing.id}; remove or update the replacement first`,
      )
    }
    return entries.filter((entry) => entry.id !== input.entryId)
  }, input.entryId)
}

export async function promoteMemoryEntry(
  options: MemoryStoreOptions,
  input: { file: string; entryId: string; expectedRevision: string; content?: string },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (entries, updatedAt) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    return entries.map((entry) => entry.id === input.entryId
      ? { ...entry, updatedAt, tier: 'stable' as const, content: input.content?.trim() || entry.content }
      : entry)
  }, input.entryId)
}

export async function markMemoryEntryDisputed(
  options: MemoryStoreOptions,
  input: { file: string; entryId: string; expectedRevision: string },
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return mutateMemoryFile(options, input.file, input.expectedRevision, (entries, updatedAt) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    return entries.map((entry) => entry.id === input.entryId
      ? { ...entry, updatedAt, status: 'disputed' as const }
      : entry)
  }, input.entryId)
}

export async function supersedeMemoryEntry(
  options: MemoryStoreOptions,
  input: {
    file: string
    entryId: string
    replacementEntryId: string
    expectedRevision: string
  },
): Promise<{ ok: true; file: string; entryId: string; replacementEntryId: string; revision: string }> {
  if (input.entryId === input.replacementEntryId) {
    throw new MemoryStoreError('invalid_selection', 'a memory entry cannot supersede itself')
  }
  const result = await mutateMemoryFile(options, input.file, input.expectedRevision, (entries, updatedAt) => {
    const target = entries.find((entry) => entry.id === input.entryId)
    const replacement = entries.find((entry) => entry.id === input.replacementEntryId)
    if (!target) throw new MemoryStoreError('not_found', `memory entry not found: ${input.entryId}`)
    if (!replacement) {
      throw new MemoryStoreError('not_found', `replacement memory entry not found: ${input.replacementEntryId}`)
    }
    return entries.map((entry) => {
      if (entry.id === input.entryId) return { ...entry, updatedAt, status: 'superseded' as const }
      if (entry.id === input.replacementEntryId) {
        return { ...entry, updatedAt, supersedes: [...new Set([...entry.supersedes, input.entryId])] }
      }
      return entry
    })
  }, input.entryId)
  return { ...result, replacementEntryId: input.replacementEntryId }
}

export async function compactMemoryEntries(
  options: MemoryStoreOptions,
  input: { file: string; entryIds: string[]; expectedRevision: string; content: string },
): Promise<{ ok: true; file: string; entryId: string; compactedEntryIds: string[]; revision: string }> {
  if (new Set(input.entryIds).size !== input.entryIds.length || input.entryIds.length < 2) {
    throw new MemoryStoreError('invalid_selection', 'compact requires at least two distinct memory entry ids')
  }
  const now = options.now?.() ?? new Date()
  const nowIso = formatBeijingIso(now)
  const entryId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
  if (input.entryIds.includes(entryId)) {
    throw new MemoryStoreError('invalid_selection', 'compacted memory entry cannot supersede itself')
  }
  const result = await mutateMemoryFile(options, input.file, input.expectedRevision, (entries) => {
    const selected = entries.filter((entry) => input.entryIds.includes(entry.id))
    if (selected.length !== input.entryIds.length) {
      throw new MemoryStoreError('not_found', 'one or more memory entries were not found')
    }
    const selectedIds = new Set(input.entryIds)
    const firstSelectedIndex = entries.findIndex((entry) => selectedIds.has(entry.id))
    const compacted: MemoryEntry = {
      id: entryId,
      createdAt: nowIso,
      updatedAt: nowIso,
      content: input.content.trim(),
      sourceMessageIds: [...new Set(selected.flatMap((entry) => entry.sourceMessageIds))],
      assertedByIds: [...new Set(selected.flatMap((entry) => entry.assertedByIds))],
      evidenceKind: commonEvidenceKind(selected),
      memoryKind: commonMemoryKind(selected),
      tier: 'stable',
      status: 'active',
      aliases: [],
      supersedes: input.entryIds,
    }
    return entries.flatMap((entry, index) => {
      if (index === firstSelectedIndex) {
        return [compacted, { ...entry, updatedAt: nowIso, status: 'superseded' as const }]
      }
      if (selectedIds.has(entry.id)) {
        return [{ ...entry, updatedAt: nowIso, status: 'superseded' as const }]
      }
      return [entry]
    })
  }, entryId)
  return { ...result, compactedEntryIds: input.entryIds }
}

export async function inspectMemoryFileForMaintenance(
  options: MemoryStoreOptions,
  file: string,
): Promise<MemoryMaintenanceSnapshot> {
  const path = safeMemoryFile(options.rootDir, file)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MemoryStoreError('not_found', `memory file not found: ${file}`)
    }
    throw error
  }
  const parsed = parseMemoryDocument(raw)
  if (!parsed) throw new MemoryStoreError('invalid_format', `memory file uses an unsupported format: ${file}`)
  const allEntries = parsed.entries.map(stripMemorySegment)
  const entries = allEntries.slice(0, MAX_REVIEW_ENTRIES)
  return {
    ok: true,
    file,
    scope: parsed.scope,
    title: parsed.title,
    ...(parsed.context ? { context: parsed.context } : {}),
    revision: revisionOf(raw),
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
    entries,
    entriesTruncated: allEntries.length > entries.length,
    recentCount: allEntries.filter((entry) => entry.tier === 'recent' && entry.status === 'active').length,
    stableCount: allEntries.filter((entry) => entry.tier === 'stable' && entry.status !== 'superseded').length,
    recentChars: allEntries
      .filter((entry) => entry.tier === 'recent' && entry.status === 'active')
      .reduce((sum, entry) => sum + entry.content.length, 0),
  }
}

export function applyMemoryMaintenance(
  options: MemoryStoreOptions,
  input: {
    file: string
    expectedRevision: string
    operations: MemoryMaintenanceOperation[]
  },
) {
  return withCoordinatedWrite(options, `memory:${input.file}`, () => (
    applyMemoryMaintenanceUnlocked(options, input)
  ))
}

async function applyMemoryMaintenanceUnlocked(
  options: MemoryStoreOptions,
  input: {
    file: string
    expectedRevision: string
    operations: MemoryMaintenanceOperation[]
  },
): Promise<{
  ok: true
  file: string
  revision: string
  promoted: number
  merged: number
  disputed: number
  discarded: number
}> {
  if (input.operations.length === 0) {
    throw new MemoryStoreError('invalid_selection', 'memory maintenance requires at least one operation')
  }
  const path = safeMemoryFile(options.rootDir, input.file)
  const raw = await readRequiredMemory(path, input.file)
  if (revisionOf(raw) !== input.expectedRevision) {
    throw new MemoryStoreError('revision_conflict', 'memory file changed; review it again before applying maintenance')
  }
  const entries = parseMemoryEntries(raw).map(stripMemorySegment)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const consumed = new Set<string>()
  const replacements = new Map<string, MemoryEntry | null>()
  const insertionsBefore = new Map<string, MemoryEntry[]>()
  let promoted = 0
  let merged = 0
  let disputed = 0
  let discarded = 0
  const now = options.now?.() ?? new Date()
  const nowIso = formatBeijingIso(now)

  function claim(entryId: string): MemoryEntry {
    const entry = byId.get(entryId)
    if (!entry) throw new MemoryStoreError('not_found', `memory entry not found: ${entryId}`)
    if (consumed.has(entryId)) {
      throw new MemoryStoreError('invalid_selection', `memory entry selected more than once: ${entryId}`)
    }
    consumed.add(entryId)
    return entry
  }

  for (const operation of input.operations) {
    if (operation.action === 'promote') {
      const entry = claim(operation.entryId)
      if (entry.tier === 'stable') {
        throw new MemoryStoreError('invalid_selection', `automatic maintenance cannot re-promote stable entry: ${entry.id}`)
      }
      if (entry.status !== 'active') {
        throw new MemoryStoreError('invalid_selection', `automatic maintenance can only promote recent active entries: ${entry.id}`)
      }
      if (new Set(entry.sourceMessageIds).size < 2) {
        throw new MemoryStoreError(
          'invalid_selection',
          `automatic maintenance promotion requires at least two distinct source messages: ${entry.id}`,
        )
      }
      replacements.set(entry.id, {
        ...entry,
        updatedAt: nowIso,
        tier: 'stable',
        content: operation.content.trim(),
      })
      promoted++
      continue
    }
    if (operation.action === 'discard') {
      const entry = claim(operation.entryId)
      if (entry.tier === 'stable') {
        throw new MemoryStoreError('invalid_selection', `automatic maintenance cannot discard stable entry: ${entry.id}`)
      }
      if (entry.status !== 'active') {
        throw new MemoryStoreError('invalid_selection', `automatic maintenance can only discard recent active entries: ${entry.id}`)
      }
      replacements.set(entry.id, null)
      discarded++
      continue
    }

    if (operation.action === 'mark_disputed') {
      if (new Set(operation.entryIds).size !== operation.entryIds.length || operation.entryIds.length < 2) {
        throw new MemoryStoreError('invalid_selection', 'mark_disputed requires at least two distinct memory entry ids')
      }
      const selected = operation.entryIds.map(claim)
      if (selected.some((entry) => entry.status === 'superseded')) {
        throw new MemoryStoreError('invalid_selection', 'automatic maintenance cannot dispute superseded entries')
      }
      for (const entry of selected) {
        replacements.set(entry.id, { ...entry, updatedAt: nowIso, status: 'disputed' })
      }
      disputed += selected.length
      continue
    }

    if (new Set(operation.entryIds).size !== operation.entryIds.length || operation.entryIds.length < 2) {
      throw new MemoryStoreError('invalid_selection', 'merge requires at least two distinct memory entry ids')
    }
    const selected = operation.entryIds.map(claim)
    if (selected.some((entry) => entry.status !== 'active')) {
      throw new MemoryStoreError('invalid_selection', 'automatic maintenance can only merge active entries')
    }
    if (selected.every((entry) => entry.tier === 'stable')) {
      throw new MemoryStoreError('invalid_selection', 'automatic maintenance merge requires at least one recent entry')
    }
    if (hasObviousContradiction(selected)) {
      for (const entry of selected) {
        replacements.set(entry.id, { ...entry, updatedAt: nowIso, status: 'disputed' })
      }
      disputed += selected.length
      continue
    }
    const first = selected[0]!
    const replacementId = options.id?.() ?? `mem_${formatBeijingCompact(now)}_${randomUUID().slice(0, 8)}`
    if (operation.entryIds.includes(replacementId)) {
      throw new MemoryStoreError('invalid_selection', 'merged memory entry cannot supersede itself')
    }
    insertionsBefore.set(first.id, [{
      id: replacementId,
      createdAt: nowIso,
      updatedAt: nowIso,
      content: operation.content.trim(),
      sourceMessageIds: [...new Set(selected.flatMap((entry) => entry.sourceMessageIds))],
      assertedByIds: [...new Set(selected.flatMap((entry) => entry.assertedByIds))],
      evidenceKind: commonEvidenceKind(selected),
      memoryKind: commonMemoryKind(selected),
      tier: 'stable',
      status: 'active',
      aliases: [...new Set(selected.flatMap((entry) => entry.aliases))],
      supersedes: selected.map((entry) => entry.id),
    }])
    for (const entry of selected) {
      replacements.set(entry.id, { ...entry, updatedAt: nowIso, status: 'superseded' })
    }
    merged++
  }

  const nextEntries = entries.flatMap((entry) => {
    const inserted = insertionsBefore.get(entry.id) ?? []
    if (!replacements.has(entry.id)) return [...inserted, entry]
    const replacement = replacements.get(entry.id)
    return replacement ? [...inserted, replacement] : inserted
  })
  if (nextEntries.length === 0) {
    throw new MemoryStoreError('invalid_selection', 'automatic maintenance cannot empty a memory file')
  }
  const next = renderManagedMemory(raw, nextEntries, nowIso)
  await atomicWrite(path, next)
  return {
    ok: true,
    file: input.file,
    revision: revisionOf(next),
    promoted,
    merged,
    disputed,
    discarded,
  }
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
    const parsed = parseMemoryDocument(raw)
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
      ...(parsed.context ? { context: parsed.context } : {}),
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

    await withCoordinatedWrite(options, `memory:${file}`, async () => {
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
    })
  }

  return { ok: failed.length === 0, deleted, missing, failed }
}

function memoryRoot(rootDir: string): string {
  return join(rootDir, 'memory')
}

function titleForInput(input: WriteMemoryInput): string {
  if (input.title?.trim()) return input.title.trim()
  if (input.id?.trim()) return input.id.trim()
  if (input.scope === 'self') return '工作笔记'
  if (input.scope === 'topic') {
    throw new MemoryStoreError(
      'invalid_input',
      'topic memory requires a stable title; recall/search the topic first, then retry write with title',
    )
  }
  return input.scope
}

function documentTitleForInput(input: WriteMemoryInput): string {
  if (input.scope === 'self') return '自我记忆'
  if (input.scope === 'topic') return '主题记忆'
  return titleForInput(input)
}

function aliasesForInput(input: WriteMemoryInput, title: string): string[] {
  return input.scope === 'self' || input.scope === 'topic' ? [title] : []
}

function fileForInput(input: WriteMemoryInput): string {
  if (input.scope === 'person') {
    const personId = requiredId(input)
    const context = input.context
    if (!context) throw new MemoryStoreError('invalid_input', 'person memory requires context')
    if (context.kind === 'core') return `people/${personId}/core.md`
    if (context.kind === 'legacy_unscoped') return `people/${personId}/unscoped.md`
    const contextId = requiredContextId(context)
    return context.kind === 'qq_group'
      ? `people/${personId}/groups/${contextId}.md`
      : `people/${personId}/private/${contextId}.md`
  }
  if (input.scope === 'group') return `groups/${requiredId(input)}.md`
  if (input.scope === 'topic') return TOPIC_MEMORY_FILE
  return SELF_MEMORY_FILE
}

function requiredContextId(context: ConversationMemoryContext): string {
  const value = context.id.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MemoryStoreError('invalid_input', `memory context id is invalid: ${context.id}`)
  }
  return value
}

function requiredId(input: WriteMemoryInput): string {
  const value = input.id?.trim()
  if (!value) throw new MemoryStoreError('invalid_input', `${input.scope} memory requires id`)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new MemoryStoreError('invalid_input', `${input.scope} id is invalid`)
  return value
}

function filesForRecall(input: RecallMemoryInput): string[] | null {
  if (input.scope === 'person' || input.scope === 'group') {
    const id = input.id?.trim()
    if (!id) throw new MemoryStoreError('invalid_input', `${input.scope} recall requires id`)
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new MemoryStoreError('invalid_input', `${input.scope} recall id is invalid`)
    }
    if (input.scope === 'group') {
      if (input.context != null) throw new MemoryStoreError('invalid_input', 'group recall does not accept context')
      return [`groups/${id}.md`]
    }
    if (!input.context) throw new MemoryStoreError('invalid_input', 'person recall requires context')
    const contextId = requiredContextId(input.context)
    return [
      `people/${id}/core.md`,
      input.context.kind === 'qq_group'
        ? `people/${id}/groups/${contextId}.md`
        : `people/${id}/private/${contextId}.md`,
    ]
  }
  if ((input.scope === 'self' || input.scope === 'topic') && (input.id != null || input.context != null)) {
    throw new MemoryStoreError('invalid_input', `${input.scope} recall does not accept id or context`)
  }
  if (input.scope == null && (input.id != null || input.context != null)) {
    throw new MemoryStoreError('invalid_input', 'unscoped recall does not accept id or context')
  }
  return null
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

function renderNewFile(input: WriteMemoryInput, title: string, updatedAt: string): string {
  return [
    '---',
    'formatVersion: 2',
    `scope: ${input.scope}`,
    ...(input.id?.trim() ? [`entityId: ${input.id.trim()}`] : []),
    ...(input.context ? [`contextKind: ${input.context.kind}`] : []),
    ...(input.context && (input.context.kind === 'qq_group' || input.context.kind === 'qq_private')
      ? [`contextId: ${input.context.id}`]
      : []),
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
    if (metaEnd < 0) throw invalidMemoryEntry('memory entry metadata is not closed')
    const close = raw.indexOf(ENTRY_END, metaEnd + 3)
    if (close < 0) throw invalidMemoryEntry('memory entry body is not closed')
    const end = close + ENTRY_END.length + (raw.slice(close + ENTRY_END.length).startsWith('\n') ? 1 : 0)
    const fields = new Map<string, string>()
    for (const line of raw.slice(start + ENTRY_START.length, metaEnd).split('\n')) {
      const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line.trim())
      if (match) fields.set(match[1]!, match[2]!)
    }
    const id = fields.get('id')
    const createdAt = fields.get('createdAt')
    const updatedAt = fields.get('updatedAt') ?? createdAt
    const tierValue = fields.get('tier')
    const tier = tierValue === 'stable' || tierValue === 'recent' ? tierValue : null
    const statusValue = fields.get('status') ?? 'active'
    const status = isMemoryStatus(statusValue) ? statusValue : null
    const aliases = parseStringArrayField(fields.get('aliases'), 'aliases')
    const validUntil = fields.get('validUntil')
    const supersedes = parseStringArrayField(fields.get('supersedes'), 'supersedes')
    const body = raw.slice(metaEnd + 3, close).replace(/^\n/, '').trim()
    if (!id || !createdAt || !updatedAt || !tier || !status || !body.startsWith('- ')) {
      throw invalidMemoryEntry('memory entry is missing required fields')
    }
    if (!isIsoTimestamp(createdAt) || !isIsoTimestamp(updatedAt)) {
      throw invalidMemoryEntry('memory entry timestamps must be ISO timestamps')
    }
    if (validUntil && !isIsoTimestamp(validUntil)) {
      throw invalidMemoryEntry('memory entry validUntil must be an ISO timestamp')
    }
    if (supersedes.includes(id)) {
      throw invalidMemoryEntry('memory entry cannot supersede itself')
    }
    entries.push({
      id,
      createdAt,
      updatedAt,
      content: body.slice(2).trim(),
      sourceMessageIds: parseSourceIds(fields.get('sourceMessageIds')),
      assertedByIds: parseIdList(fields.get('assertedByIds')),
      ...(isMemoryEvidenceKind(fields.get('evidenceKind'))
        ? { evidenceKind: fields.get('evidenceKind') as MemoryEvidenceKind }
        : {}),
      ...(isMemoryKind(fields.get('memoryKind'))
        ? { memoryKind: fields.get('memoryKind') as MemoryKind }
        : {}),
      tier,
      status,
      aliases,
      ...(validUntil ? { validUntil } : {}),
      supersedes,
      start,
      end,
    })
    offset = Math.max(end, close + ENTRY_END.length)
  }
  return entries
}

function invalidMemoryEntry(message: string): MemoryStoreError {
  return new MemoryStoreError('invalid_format', message)
}

function isMemoryStatus(value: string): value is MemoryStatus {
  return value === 'active' || value === 'disputed' || value === 'superseded'
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value))
}

function parseStringArrayField(raw: string | undefined, field: string): string[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalidMemoryEntry(`memory entry ${field} must be a JSON string array`)
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw invalidMemoryEntry(`memory entry ${field} must be a JSON string array`)
  }
  return parsed
}

function parseSourceIds(raw: string | undefined): number[] {
  if (!raw) return []
  return raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value))
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

function searchableMemoryText(entries: readonly MemoryEntry[]): string {
  return entries
    .filter((entry) => entry.status !== 'superseded')
    .map((entry) => entry.content)
    .join('\n')
}

async function mutateMemoryFile(
  options: MemoryStoreOptions,
  file: string,
  expectedRevision: string,
  mutate: (entries: MemorySegment[], updatedAt: string) => MemoryEntry[],
  entryId: string,
): Promise<{ ok: true; file: string; entryId: string; revision: string }> {
  return withCoordinatedWrite(options, `memory:${file}`, async () => {
    const path = safeMemoryFile(options.rootDir, file)
    const raw = await readRequiredMemory(path, file)
    if (revisionOf(raw) !== expectedRevision) {
      throw new MemoryStoreError('revision_conflict', 'memory file changed; read it again and retry with the latest revision')
    }
    const now = options.now?.() ?? new Date()
    const updatedAt = formatBeijingIso(now)
    const next = renderManagedMemory(raw, mutate(parseMemoryEntries(raw), updatedAt), updatedAt)
    await atomicWrite(path, next)
    return { ok: true, file, entryId, revision: revisionOf(next) }
  })
}

async function readRequiredMemory(path: string, file: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MemoryStoreError('not_found', `memory file not found: ${file}`)
    }
    throw error
  }
  if (!parseMemoryDocument(raw)) {
    throw new MemoryStoreError('invalid_format', `memory file uses an unsupported format: ${file}`)
  }
  return raw
}

function stripMemorySegment(entry: MemorySegment): MemoryEntry {
  const { start: _start, end: _end, ...memoryEntry } = entry
  return memoryEntry
}

function renderManagedMemory(raw: string, entries: readonly MemoryEntry[], updatedAt: string): string {
  const frontmatterEnd = raw.indexOf('\n---\n', 4)
  if (!raw.startsWith('---\n') || frontmatterEnd < 0) {
    throw new MemoryStoreError('invalid_format', 'memory file uses an unsupported format')
  }
  const frontmatter = replaceUpdatedAt(raw.slice(0, frontmatterEnd + 5), updatedAt).trimEnd()
  const stable = entries.filter((entry) => entry.tier === 'stable').map(renderMemoryEntry).join('')
  const recent = entries.filter((entry) => entry.tier === 'recent').map(renderMemoryEntry).join('')
  const lines = [
    frontmatter,
    '',
    '## 稳定记忆',
    '',
  ]
  if (stable) lines.push(stable.trimEnd(), '')
  lines.push('## 最近线索', '')
  if (recent) lines.push(recent.trimEnd(), '')
  return `${lines.join('\n').trimEnd()}\n`
}

function parseMemoryDocument(raw: string): {
  scope: MemoryScope
  title: string
  context?: MemoryContext
  updatedAt: string | null
  entries: MemorySegment[]
} | null {
  const metadata = parseMarkdownMemory(raw)
  if (!metadata) return null
  try {
    return { ...metadata, entries: parseMemoryEntries(raw) }
  } catch (error) {
    if (error instanceof MemoryStoreError && error.code === 'invalid_format') return null
    throw error
  }
}

function parseMarkdownMemory(raw: string): {
  scope: MemoryScope
  title: string
  context?: MemoryContext
  updatedAt: string | null
} | null {
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
  if ((record.formatVersion !== '1' && record.formatVersion !== '2') || !isMemoryScope(record.scope)) return null
  let context: MemoryContext | undefined
  if (record.formatVersion === '2' && record.scope === 'person') {
    if (record.contextKind === 'core') context = { kind: 'core' }
    else if (record.contextKind === 'legacy_unscoped') context = { kind: 'legacy_unscoped' }
    else if ((record.contextKind === 'qq_group' || record.contextKind === 'qq_private') && record.contextId) {
      context = { kind: record.contextKind, id: record.contextId }
    } else return null
  }
  return {
    scope: record.scope,
    title: record.title || 'untitled',
    ...(context ? { context } : {}),
    updatedAt: record.updatedAt || null,
  }
}

function isMemoryScope(value: string | undefined): value is MemoryScope {
  return value === 'self' || value === 'person' || value === 'group' || value === 'topic'
}

function isMemoryEvidenceKind(value: string | undefined): value is MemoryEvidenceKind {
  return value === 'self_report'
    || value === 'owner_assertion'
    || value === 'third_party_report'
    || value === 'observed_pattern'
    || value === 'explicit_rule'
    || value === 'legacy_unverified'
}

function commonEvidenceKind(entries: readonly MemoryEntry[]): MemoryEvidenceKind | undefined {
  const kinds = new Set(entries.map((entry) => entry.evidenceKind).filter(isDefined))
  return kinds.size === 1 ? [...kinds][0] : undefined
}

function commonMemoryKind(entries: readonly MemoryEntry[]): MemoryKind | undefined {
  const kinds = new Set(entries.map((entry) => entry.memoryKind).filter(isDefined))
  return kinds.size === 1 ? [...kinds][0] : undefined
}

function isMemoryKind(value: string | undefined): value is MemoryKind {
  return value === 'person_identity'
    || value === 'person_preference'
    || value === 'person_behavior'
    || value === 'person_relationship'
    || value === 'group_rule'
    || value === 'group_rhythm'
    || value === 'group_topic'
    || value === 'group_culture'
    || value === 'group_history'
    || value === 'group_structure'
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
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

function recallQueryTerms(value: string): Array<{ value: string; weight: number }> {
  const terms = new Map<string, number>()
  const add = (term: string, weight: number) => {
    const normalized = normalizeSearchText(term)
    if (!normalized) return
    terms.set(normalized, Math.max(terms.get(normalized) ?? 0, weight))
  }
  for (const match of value.toLocaleLowerCase().matchAll(/[a-z0-9][a-z0-9_-]*|[\u3400-\u9fff]+/g)) {
    const chunk = match[0]
    if (!/^[\u3400-\u9fff]+$/.test(chunk)) {
      add(chunk, 12)
      continue
    }
    if (chunk.length <= 20) add(chunk, 12)
    for (const size of [2, 3]) {
      for (let index = 0; index <= chunk.length - size; index++) {
        add(chunk.slice(index, index + size), size === 3 ? 5 : 3)
      }
    }
  }
  return [...terms].map(([term, weight]) => ({ value: term, weight }))
}

function identityFromMemoryFile(scope: MemoryScope, file: string): string {
  const pattern = scope === 'person'
    ? /^people\/([^/]+)(?:\.md|\/)/
    : scope === 'group'
      ? /^groups\/([^/]+)\.md$/
      : null
  return normalizeSearchText(pattern?.exec(file)?.[1] ?? '')
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

function hasObviousContradiction(entries: readonly MemoryEntry[]): boolean {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const left = entries[leftIndex]!
      const right = entries[rightIndex]!
      if (hasNegation(left.content) === hasNegation(right.content)) continue
      const similarity = jaccard(new Set(lexicalTerms(left.content)), new Set(lexicalTerms(right.content)))
      if (similarity >= 0.4) return true
    }
  }
  return false
}
