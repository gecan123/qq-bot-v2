import '@tanstack/react-start/server-only'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { getAdminPrisma } from '../../server/db.server.js'
import { getWorkspaceRoot } from '../../server/paths.server.js'
import { memoryFileSnapshotSchema, memorySnapshotSchema, type MemoryFileSnapshot, type MemorySnapshot } from './memory.schema.js'

type KnowledgeKind = 'memory' | 'journal' | 'notebook'

export async function loadMemorySnapshot(now = new Date()): Promise<MemorySnapshot> {
  const workspace = getWorkspaceRoot()
  const roots = knowledgeRoots(workspace)
  const descriptors = (await Promise.all(roots.map(async root => (await walk(root.path)).map(path => ({ ...root, path }))))).flat()
  const loaded = await Promise.all(descriptors.map(async item => {
    const [raw, info] = await Promise.all([readFile(item.path, 'utf8'), stat(item.path)])
    const file = relative(workspace, item.path)
    const fileId = encodeMemoryFileId(file)
    const entries = parseEntries(raw, file, fileId, item.kind, 1_600)
    return { file: { fileId, path: file, kind: item.kind, updatedAt: info.mtime.toISOString(), size: info.size, entryCount: entries.length }, entries }
  }))
  const entries = loaded.flatMap(item => item.entries).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 250)
  const sourceIds = [...new Set(entries.flatMap(item => item.sourceMessageIds))].slice(0, 300)
  const provenance = await readProvenance(sourceIds)
  const warnings: string[] = []
  if (!sourceIds.length) warnings.push('当前条目没有 sourceMessageIds；legacy_unverified 只能展示记录本身，不能反推消息来源。')
  return memorySnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(),
    counts: { files: loaded.length, entries: loaded.filter(item => item.file.kind === 'memory').reduce((sum, item) => sum + item.entries.length, 0), journalFiles: loaded.filter(item => item.file.kind === 'journal').length, journalEntries: loaded.filter(item => item.file.kind === 'journal').reduce((sum, item) => sum + item.entries.length, 0), sourceLinks: sourceIds.length },
    files: loaded.map(item => item.file).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), entries, provenance, warnings,
  })
}

export async function loadMemoryFile(fileId: string, now = new Date()): Promise<MemoryFileSnapshot> {
  const workspace = getWorkspaceRoot()
  const file = decodeMemoryFileId(fileId)
  const kind = knowledgeKind(file)
  if (!kind) throw new Error('不支持的知识文件路径')
  const absolute = resolve(workspace, file)
  const workspacePrefix = `${resolve(workspace)}${sep}`
  if (!absolute.startsWith(workspacePrefix)) throw new Error('知识文件路径越界')
  const [raw, info] = await Promise.all([readFile(absolute, 'utf8'), stat(absolute)])
  if (!info.isFile()) throw new Error('知识文件不存在')
  const entries = parseEntries(raw, file, fileId, kind, null)
  const sourceIds = [...new Set(entries.flatMap(entry => entry.sourceMessageIds))].slice(0, 500)
  const metadata = parseFrontMatter(raw)
  return memoryFileSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    file: {
      fileId,
      path: file,
      kind,
      updatedAt: info.mtime.toISOString(),
      size: info.size,
      title: metadata.title ?? file.split('/').at(-1)?.replace(/\.md$/i, '') ?? file,
      metadata,
      rawMarkdown: raw,
    },
    entries,
    provenance: await readProvenance(sourceIds),
  })
}

export function encodeMemoryFileId(file: string): string {
  return Buffer.from(file, 'utf8').toString('base64url')
}

function decodeMemoryFileId(fileId: string): string {
  let decoded: string
  try { decoded = Buffer.from(fileId, 'base64url').toString('utf8') } catch { throw new Error('无效的知识文件标识') }
  if (!decoded || decoded.includes('\\') || decoded.startsWith('/') || decoded.split('/').includes('..')) throw new Error('无效的知识文件路径')
  return decoded
}

function knowledgeRoots(workspace: string): Array<{ path: string; kind: KnowledgeKind }> {
  return [
    { path: join(workspace, 'memory'), kind: 'memory' },
    { path: join(workspace, 'life', 'journal'), kind: 'journal' },
    { path: join(workspace, 'notebook'), kind: 'notebook' },
  ]
}

function knowledgeKind(file: string): KnowledgeKind | null {
  if (!file.endsWith('.md')) return null
  if (file.startsWith('memory/')) return 'memory'
  if (file.startsWith('life/journal/')) return 'journal'
  if (file.startsWith('notebook/')) return 'notebook'
  return null
}

async function readProvenance(sourceIds: number[]): Promise<MemorySnapshot['provenance']> {
  if (!sourceIds.length) return []
  const messages = await getAdminPrisma().message.findMany({ where: { id: { in: sourceIds } }, select: { id: true, sceneKind: true, sceneExternalId: true, groupId: true, senderId: true, senderNickname: true, sentAt: true, createdAt: true, resolvedText: true, searchText: true }, orderBy: { id: 'desc' } })
  return messages.map(row => ({ id: row.id, scene: row.sceneKind === 'qq_group' ? `群 ${row.groupId ?? '—'}` : `私聊 ${row.sceneExternalId}`, sender: row.senderNickname ?? row.senderId.toString(), sentAt: (row.sentAt ?? row.createdAt).toISOString(), text: (row.resolvedText || row.searchText).slice(0, 500) }))
}

async function walk(root: string): Promise<string[]> { try { const rows = await readdir(root, { withFileTypes: true }); return (await Promise.all(rows.map(row => row.isDirectory() ? walk(join(root, row.name)) : row.name.endsWith('.md') ? [join(root, row.name)] : []))).flat() } catch { return [] } }

function parseEntries(raw: string, file: string, fileId: string, kind: KnowledgeKind, textLimit: number | null): MemorySnapshot['entries'] {
  return kind === 'memory' ? parseMemory(raw, file, fileId, textLimit) : parseJournal(raw, file, fileId, kind, textLimit)
}

function parseMemory(raw: string, file: string, fileId: string, textLimit: number | null): MemorySnapshot['entries'] {
  const rows: MemorySnapshot['entries'] = []
  const regex = /<!-- memory-entry\s*([\s\S]*?)-->\s*([\s\S]*?)<!-- \/memory-entry -->/g
  for (const match of raw.matchAll(regex)) { const meta = match[1]; rows.push({ id: field(meta, 'id') ?? `${file}:${rows.length + 1}`, fileId, file, tier: field(meta, 'tier'), status: field(meta, 'status'), evidenceKind: field(meta, 'evidenceKind'), updatedAt: field(meta, 'updatedAt'), sourceMessageIds: numericArray(meta, 'sourceMessageIds'), text: limit(match[2].replace(/^\s*[-*]\s*/, '').trim(), textLimit) }) }
  return rows
}

function parseJournal(raw: string, file: string, fileId: string, kind: 'journal' | 'notebook', textLimit: number | null): MemorySnapshot['entries'] { const chunks = raw.split(/(?=^##\s+)/m).filter(part => part.trim()); return chunks.slice(0, 300).map((part, index) => ({ id: `${file}:${index + 1}`, fileId, file, tier: kind, status: null, evidenceKind: null, updatedAt: null, sourceMessageIds: numericArray(part, 'sourceMessageIds'), text: limit(part.trim(), textLimit) })) }
function parseFrontMatter(raw: string): Record<string, string> { const match = /^---\s*\n([\s\S]*?)\n---/.exec(raw); if (!match) return {}; const result: Record<string, string> = {}; for (const line of match[1].split('\n')) { const separator = line.indexOf(':'); if (separator <= 0) continue; result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^"|"$/g, '') } return result }
function field(raw: string, key: string): string | null { return new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(raw)?.[1]?.trim().replace(/^"|"$/g, '') ?? null }
function numericArray(raw: string, key: string): number[] { const value = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(raw)?.[1]; return value ? value.split(',').map(item => Number(item.trim())).filter(Number.isSafeInteger) : [] }
function limit(value: string, max: number | null): string { return max === null || value.length <= max ? value : `${value.slice(0, max)}…` }
