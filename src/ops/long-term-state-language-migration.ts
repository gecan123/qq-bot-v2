import { createHash, randomUUID } from 'node:crypto'
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  listMemoryFiles,
  readMemoryFile,
  updateMemoryEntry,
  type MemoryScope,
} from '../agent/memory-store.js'
import {
  listNotebookRecords,
  readNotebookRecordSnapshot,
  updateNotebookRecord,
} from '../agent/notebook-store.js'
import {
  readLifeAgendaSnapshot,
  readLifeJournalDay,
  updateLifeJournalEntry,
  writeLifeAgendaIfRevision,
} from '../agent/life-journal-store.js'
import { hasChineseNarrative } from '../agent/long-term-language.js'

export interface LongTermTranslationItem {
  key: string
  text: string
  kind: 'title' | 'content' | 'markdown' | 'agenda_item'
}

export interface LongTermTranslation {
  key: string
  text: string
}

export interface LongTermStateLanguageMigrationResult {
  backupDir: string
  repairedNestedJournalEntries: number
  translated: {
    memoryTitles: number
    memoryEntries: number
    notebookTopics: number
    notebookEntries: number
    lifeJournalEntries: number
    agendaItems: number
  }
  renamedMemoryFiles: Array<{ from: string; to: string }>
  translatedItems: number
}

interface MemoryPlan {
  file: string
  scope: MemoryScope
  title: string
  titleKey?: string
  entries: Array<{ id: string; content: string; key?: string }>
}

interface NotebookPlan {
  id: string
  topic: string
  content: string
  topicKey?: string
  contentKey?: string
}

interface JournalPlan {
  date: string
  entries: Array<{ id: string; markdown: string; key?: string }>
}

interface AgendaLinePlan {
  index: number
  prefix: string
  text: string
  key: string
}

const LEGACY_JOURNAL_HEADING = /^###\s+(?:Saw|Did|Promised|I care about|Next|Mood)\s*$/m
const ENGLISH_WORD = /\b[A-Za-z][A-Za-z'-]{2,}\b/g
const MEMORY_TITLE_MAX = 80
const NOTEBOOK_TOPIC_MAX = 120
const MEMORY_ENTRY_MAX = 2_000
const NOTEBOOK_ENTRY_MAX = 12_000
const LIFE_ENTRY_MAX = 12_000

export async function migrateLongTermStateToChinese(input: {
  rootDir: string
  translate(items: readonly LongTermTranslationItem[]): Promise<readonly LongTermTranslation[]>
  now?: () => Date
}): Promise<LongTermStateLanguageMigrationResult> {
  const rootDir = resolve(input.rootDir)
  const backupDir = await backupLongTermState(rootDir, input.now?.() ?? new Date())
  const repairedNestedJournalEntries = await repairNestedLifeJournalEntries(rootDir)
  const requests: LongTermTranslationItem[] = []

  const memoryPlans = await collectMemoryPlans(rootDir, requests)
  const notebookPlans = await collectNotebookPlans(rootDir, requests)
  const journalPlans = await collectJournalPlans(rootDir, requests)
  const agenda = await collectAgendaPlan(rootDir, requests)

  const translations = await input.translate(requests)
  const translated = validateTranslations(requests, translations)
  const counts = {
    memoryTitles: 0,
    memoryEntries: 0,
    notebookTopics: 0,
    notebookEntries: 0,
    lifeJournalEntries: 0,
    agendaItems: 0,
  }
  const renamedMemoryFiles: Array<{ from: string; to: string }> = []

  for (const plan of memoryPlans) {
    let currentFile = plan.file
    const initial = await readMemoryFile({ rootDir }, { file: currentFile, maxChars: 12_000 })
    if (!initial.ok) throw new Error(`memory migration read failed: ${currentFile}: ${initial.error}`)
    let revision = initial.revision
    for (const entry of plan.entries) {
      if (!entry.key) continue
      const content = translated.get(entry.key)!
      assertBoundedChinese(content, MEMORY_ENTRY_MAX, entry.key)
      const result = await updateMemoryEntry({ rootDir }, {
        file: currentFile,
        entryId: entry.id,
        expectedRevision: revision,
        content,
      })
      revision = result.revision
      counts.memoryEntries += 1
    }

    if (plan.titleKey) {
      const title = translated.get(plan.titleKey)!
      assertBoundedChinese(title, MEMORY_TITLE_MAX, plan.titleKey)
      const renamed = await rewriteMemoryTitleAndPath({
        rootDir,
        file: currentFile,
        scope: plan.scope,
        expectedRevision: revision,
        title,
      })
      currentFile = renamed.file
      counts.memoryTitles += 1
      if (renamed.file !== plan.file) renamedMemoryFiles.push({ from: plan.file, to: renamed.file })
    }
  }

  for (const plan of notebookPlans) {
    if (!plan.topicKey && !plan.contentKey) continue
    const snapshot = await readNotebookRecordSnapshot({ rootDir }, plan.id)
    if (!snapshot) throw new Error(`notebook migration entry disappeared: ${plan.id}`)
    const topic = plan.topicKey ? translated.get(plan.topicKey)! : plan.topic
    const content = plan.contentKey ? translated.get(plan.contentKey)! : plan.content
    assertBoundedChinese(topic, NOTEBOOK_TOPIC_MAX, plan.topicKey ?? `${plan.id}:topic`)
    assertBoundedChinese(content, NOTEBOOK_ENTRY_MAX, plan.contentKey ?? `${plan.id}:content`)
    await updateNotebookRecord({
      rootDir,
      entryId: plan.id,
      expectedRevision: snapshot.revision,
      topic,
      content,
    })
    if (plan.topicKey) counts.notebookTopics += 1
    if (plan.contentKey) counts.notebookEntries += 1
  }

  for (const plan of journalPlans) {
    let file = await readLifeJournalDay({ rootDir, date: plan.date })
    for (const entry of plan.entries) {
      if (!entry.key) continue
      const markdown = translated.get(entry.key)!
      assertBoundedChinese(markdown, LIFE_ENTRY_MAX, entry.key)
      const result = await updateLifeJournalEntry({
        rootDir,
        date: plan.date,
        entryId: entry.id,
        expectedRevision: file.revision,
        markdown,
      })
      file = await readLifeJournalDay({ rootDir, date: plan.date })
      if (file.revision !== result.revision) {
        throw new Error(`life journal revision changed unexpectedly during migration: ${plan.date}`)
      }
      counts.lifeJournalEntries += 1
    }
  }

  if (agenda.lines.length > 0) {
    const lines = agenda.markdown.split('\n')
    for (const line of agenda.lines) {
      const text = translated.get(line.key)!
      assertBoundedChinese(text, 2_000, line.key)
      lines[line.index] = `${line.prefix}${text}`
      counts.agendaItems += 1
    }
    await writeLifeAgendaIfRevision({
      rootDir,
      expectedRevision: agenda.revision,
    }, lines.join('\n'))
  }

  await assertLongTermStateUsesChinese(rootDir)
  return {
    backupDir,
    repairedNestedJournalEntries,
    translated: counts,
    renamedMemoryFiles,
    translatedItems: requests.length,
  }
}

function needsTranslation(value: string): boolean {
  if (!hasChineseNarrative(value)) return true
  if (LEGACY_JOURNAL_HEADING.test(value)) return true
  return (value.match(ENGLISH_WORD)?.length ?? 0) >= 4
}

async function collectMemoryPlans(
  rootDir: string,
  requests: LongTermTranslationItem[],
): Promise<MemoryPlan[]> {
  const listed = await listMemoryFiles({ rootDir }, { limit: 100 })
  if (listed.truncated) throw new Error('memory migration supports at most 100 files per run')
  const plans: MemoryPlan[] = []
  for (const file of listed.files) {
    const read = await readMemoryFile({ rootDir }, { file: file.file, maxChars: 12_000 })
    if (!read.ok) throw new Error(`memory migration read failed: ${file.file}: ${read.error}`)
    if (read.entriesTruncated) throw new Error(`memory migration entry list truncated: ${file.file}`)
    const titleNeedsTranslation = shouldTranslateMemoryTitle(file.scope, file.title) && needsTranslation(file.title)
    const titleKey = titleNeedsTranslation ? `memory:${file.file}:title` : undefined
    if (titleKey) requests.push({ key: titleKey, text: file.title, kind: 'title' })
    const entries = read.entries.map((entry) => {
      const key = needsTranslation(entry.content) ? `memory:${file.file}:entry:${entry.id}` : undefined
      if (key) requests.push({ key, text: entry.content, kind: 'content' })
      return { id: entry.id, content: entry.content, key }
    })
    plans.push({ file: file.file, scope: file.scope, title: file.title, titleKey, entries })
  }
  return plans
}

function shouldTranslateMemoryTitle(scope: MemoryScope, title: string): boolean {
  return (scope === 'self' || scope === 'topic') && Boolean(title.trim())
}

async function collectNotebookPlans(
  rootDir: string,
  requests: LongTermTranslationItem[],
): Promise<NotebookPlan[]> {
  const listed = await listNotebookRecords({ rootDir })
  const plans: NotebookPlan[] = []
  for (const entry of listed.entries) {
    const topicKey = needsTranslation(entry.topic) ? `notebook:${entry.id}:topic` : undefined
    const contentKey = needsTranslation(entry.content) ? `notebook:${entry.id}:content` : undefined
    if (topicKey) requests.push({ key: topicKey, text: entry.topic, kind: 'title' })
    if (contentKey) requests.push({ key: contentKey, text: entry.content, kind: 'content' })
    plans.push({ id: entry.id, topic: entry.topic, content: entry.content, topicKey, contentKey })
  }
  return plans
}

async function collectJournalPlans(
  rootDir: string,
  requests: LongTermTranslationItem[],
): Promise<JournalPlan[]> {
  const dir = join(rootDir, 'life', 'journal')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const plans: JournalPlan[] = []
  for (const name of names.filter((candidate) => /^\d{4}-\d{2}-\d{2}\.md$/.test(candidate)).sort()) {
    const date = name.slice(0, -3)
    const file = await readLifeJournalDay({ rootDir, date })
    const entries = file.entries.map((entry) => {
      const key = needsTranslation(entry.markdown) ? `life:${date}:entry:${entry.id}` : undefined
      if (key) requests.push({ key, text: entry.markdown, kind: 'markdown' })
      return { id: entry.id, markdown: entry.markdown, key }
    })
    plans.push({ date, entries })
  }
  return plans
}

async function collectAgendaPlan(
  rootDir: string,
  requests: LongTermTranslationItem[],
): Promise<{ markdown: string; revision: string; lines: AgendaLinePlan[] }> {
  const snapshot = await readLifeAgendaSnapshot({ rootDir })
  const lines: AgendaLinePlan[] = []
  for (const [index, raw] of snapshot.markdown.split('\n').entries()) {
    if (!raw.trim() || /^#{1,2}\s+(?:Agenda|Active|Waiting|Someday|Done)\s*$/.test(raw)) continue
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue
    const checkbox = /^(\s*-\s*\[[ xX]\]\s*)(.*)$/.exec(raw)
    const prefix = checkbox?.[1] ?? ''
    const text = checkbox?.[2] ?? raw
    if (!text.trim() || !needsTranslation(text)) continue
    const key = `agenda:line:${index}`
    requests.push({ key, text, kind: 'agenda_item' })
    lines.push({ index, prefix, text, key })
  }
  return { ...snapshot, lines }
}

function validateTranslations(
  requests: readonly LongTermTranslationItem[],
  translations: readonly LongTermTranslation[],
): Map<string, string> {
  const expected = new Set(requests.map((item) => item.key))
  const result = new Map<string, string>()
  for (const translation of translations) {
    if (!expected.has(translation.key)) throw new Error(`translation returned unknown key: ${translation.key}`)
    if (result.has(translation.key)) throw new Error(`translation returned duplicate key: ${translation.key}`)
    const text = translation.text.trim()
    if (!hasChineseNarrative(text)) throw new Error(`translation is not carried by Chinese: ${translation.key}`)
    result.set(translation.key, text)
  }
  const missing = [...expected].filter((key) => !result.has(key))
  if (missing.length > 0) throw new Error(`translation omitted keys: ${missing.join(', ')}`)
  return result
}

function assertBoundedChinese(value: string, max: number, key: string): void {
  if (!value.trim() || value.length > max || !hasChineseNarrative(value)) {
    throw new Error(`invalid translated long-term state field: ${key}`)
  }
}

async function rewriteMemoryTitleAndPath(input: {
  rootDir: string
  file: string
  scope: MemoryScope
  expectedRevision: string
  title: string
}): Promise<{ file: string }> {
  const oldPath = join(input.rootDir, 'memory', input.file)
  const raw = await readFile(oldPath, 'utf8')
  if (revisionOf(raw) !== input.expectedRevision) {
    throw new Error(`memory changed before title migration: ${input.file}`)
  }
  const next = raw.replace(/^title:.*$/m, `title: ${input.title}`)
  if (next === raw) throw new Error(`memory title field missing: ${input.file}`)
  await atomicWrite(oldPath, next)

  if (input.scope !== 'self' && input.scope !== 'topic') return { file: input.file }
  const directory = dirname(input.file)
  const desired = `${directory}/${slug(input.title)}.md`
  const file = await availableMemoryPath(input.rootDir, desired, input.file)
  if (file !== input.file) {
    const target = join(input.rootDir, 'memory', file)
    await mkdir(dirname(target), { recursive: true })
    await rename(oldPath, target)
  }
  return { file }
}

async function availableMemoryPath(rootDir: string, desired: string, current: string): Promise<string> {
  if (desired === current || !(await exists(join(rootDir, 'memory', desired)))) return desired
  const stem = desired.slice(0, -3)
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${stem}-${index}.md`
    if (candidate === current || !(await exists(join(rootDir, 'memory', candidate)))) return candidate
  }
  throw new Error(`cannot allocate translated memory path for ${desired}`)
}

function slug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || '未命名'
}

async function backupLongTermState(rootDir: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const backupDir = join(rootDir, 'db-backups', `long-term-language-${stamp}`)
  await mkdir(backupDir, { recursive: true })
  for (const name of ['memory', 'notebook', 'life']) {
    const source = join(rootDir, name)
    if (await exists(source)) await cp(source, join(backupDir, name), { recursive: true })
  }
  return backupDir
}

export async function repairNestedLifeJournalEntries(rootDir: string): Promise<number> {
  const dir = join(rootDir, 'life', 'journal')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let repaired = 0
  for (const name of names.filter((candidate) => candidate.endsWith('.md'))) {
    const path = join(dir, name)
    let raw = await readFile(path, 'utf8')
    let changed = false
    while (true) {
      const outerStart = raw.indexOf('<!-- life-journal-entry\n')
      if (outerStart < 0) break
      let cursor = outerStart
      let foundNested = false
      while (cursor >= 0) {
        const close = raw.indexOf('<!-- /life-journal-entry -->', cursor)
        const nested = raw.indexOf('<!-- life-journal-entry\n', cursor + 1)
        if (nested < 0 || (close >= 0 && close < nested)) {
          cursor = close < 0 ? -1 : raw.indexOf('<!-- life-journal-entry\n', close)
          if (cursor < 0) break
          continue
        }
        raw = `${raw.slice(0, cursor)}${raw.slice(nested)}`
        repaired += 1
        changed = true
        foundNested = true
        break
      }
      if (!foundNested) break
    }
    raw = raw.replace(
      /(<!-- life-journal-entry\n(?:[^\n]*\n)*?source: )round(\ncreatedAt: [^\n]+\n)roundIndex: ([^\n]+)\n-->\n## (\d{2}:\d{2}) [^\n]+/g,
      (match, prefix: string, createdAt: string, roundIndex: string, time: string) => {
        if (/^\d+$/.test(roundIndex.trim())) return match
        repaired += 1
        changed = true
        return `${prefix}manual${createdAt}-->\n## ${time} Manual`
      },
    )
    const duplicateClose = /<!-- \/life-journal-entry -->\n<!-- \/life-journal-entry -->/g
    const withoutDuplicateCloses = raw.replace(duplicateClose, '<!-- /life-journal-entry -->')
    if (withoutDuplicateCloses !== raw) {
      repaired += 1
      changed = true
      raw = withoutDuplicateCloses
    }
    if (changed) await atomicWrite(path, raw)
  }
  return repaired
}

export async function assertLongTermStateUsesChinese(rootDir: string): Promise<void> {
  const failures: string[] = []
  const memories = await listMemoryFiles({ rootDir }, { limit: 100 })
  for (const file of memories.files) {
    if ((file.scope === 'self' || file.scope === 'topic') && !hasChineseNarrative(file.title)) {
      failures.push(`memory title: ${file.file}`)
    }
    const read = await readMemoryFile({ rootDir }, { file: file.file, maxChars: 12_000 })
    if (!read.ok) {
      failures.push(`memory unreadable: ${file.file}`)
      continue
    }
    for (const entry of read.entries) {
      if (!hasChineseNarrative(entry.content)) failures.push(`memory entry: ${file.file}#${entry.id}`)
    }
  }
  const notebooks = await listNotebookRecords({ rootDir })
  for (const entry of notebooks.entries) {
    if (!hasChineseNarrative(entry.topic)) failures.push(`notebook topic: ${entry.id}`)
    if (!hasChineseNarrative(entry.content)) failures.push(`notebook entry: ${entry.id}`)
  }
  const journalDir = join(rootDir, 'life', 'journal')
  if (await exists(journalDir)) {
    for (const name of (await readdir(journalDir)).filter((candidate) => /^\d{4}-\d{2}-\d{2}\.md$/.test(candidate))) {
      const file = await readLifeJournalDay({ rootDir, date: name.slice(0, -3) })
      const raw = await readFile(join(journalDir, name), 'utf8')
      const opens = raw.match(/<!-- life-journal-entry\n/g)?.length ?? 0
      const closes = raw.match(/<!-- \/life-journal-entry -->/g)?.length ?? 0
      if (opens !== closes || file.entries.length !== opens) failures.push(`life journal structure: ${name}`)
      for (const entry of file.entries) {
        if (!hasChineseNarrative(entry.markdown)) failures.push(`life journal entry: ${name}#${entry.id}`)
      }
    }
  }
  const agenda = await readLifeAgendaSnapshot({ rootDir })
  for (const [index, line] of agenda.markdown.split('\n').entries()) {
    if (!line.trim() || /^#{1,2}\s+(?:Agenda|Active|Waiting|Someday|Done)\s*$/.test(line)) continue
    if (/^\s*<!--.*-->\s*$/.test(line)) continue
    const text = /^(?:\s*-\s*\[[ xX]\]\s*)(.*)$/.exec(line)?.[1] ?? line
    if (text.trim() && !hasChineseNarrative(text)) failures.push(`agenda line: ${index + 1}`)
  }
  if (failures.length > 0) throw new Error(`long-term state still has non-Chinese narrative:\n${failures.join('\n')}`)
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
