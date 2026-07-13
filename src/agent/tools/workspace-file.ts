import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'

const DEFAULT_ROOT_DIR = 'data/agent-workspace'
const MAX_FILE_BYTES = 256 * 1024
const DEFAULT_READ_CHARS = 8_000
const MAX_READ_CHARS = 32_000
const MAX_WRITE_CHARS = 100_000
const MAX_LIST = 100
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv'])
const RESERVED_TOP_LEVEL = new Set(['browser', 'data', 'db-backups', 'journal', 'life', 'memory', 'notebook', 'skill-drafts'])
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('列出普通私有工作目录中的文件和子目录.'),
    directory: z.string().trim().max(240).optional().describe('相对目录, 默认工作区根目录.'),
    limit: z.number().int().min(1).max(MAX_LIST).optional(),
  }),
  z.object({
    action: z.literal('read').describe('分页读取一个普通文本工作文件, 并返回 revision.'),
    file: z.string().trim().min(1).max(240),
    offset: z.number().int().min(0).optional(),
    maxChars: z.number().int().min(100).max(MAX_READ_CHARS).optional(),
  }),
  z.object({
    action: z.literal('write').describe('创建新文件或用最新 revision 整体覆盖已有文件.'),
    file: z.string().trim().min(1).max(240),
    content: z.string().max(MAX_WRITE_CHARS),
    expectedRevision: revisionSchema.optional().describe('覆盖已有文件时必填; 创建新文件时不传.'),
  }),
  z.object({
    action: z.literal('replace').describe('在文件中精确替换唯一一段文本.'),
    file: z.string().trim().min(1).max(240),
    expectedRevision: revisionSchema,
    oldText: z.string().min(1).max(MAX_WRITE_CHARS),
    newText: z.string().max(MAX_WRITE_CHARS),
  }),
  z.object({
    action: z.literal('delete').describe('永久删除一个明确文件.'),
    file: z.string().trim().min(1).max(240),
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal('move').describe('移动或重命名一个明确文件, 目标必须不存在.'),
    source: z.string().trim().min(1).max(240),
    destination: z.string().trim().min(1).max(240),
    expectedRevision: revisionSchema,
  }),
])

type Args = z.infer<typeof argsSchema>

export interface WorkspaceFileToolDeps {
  rootDir?: string
}

class WorkspaceFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

function revisionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizedRelativePath(value: string, allowEmpty = false): string {
  const trimmed = value.trim().replace(/\\/g, '/')
  if (allowEmpty && (trimmed === '' || trimmed === '.')) return ''
  if (!trimmed || isAbsolute(trimmed) || trimmed.startsWith('~')) {
    throw new WorkspaceFileError('path_not_allowed', `workspace path is not allowed: ${value}`)
  }
  const normalized = normalize(trimmed).replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (normalized === '..' || normalized.startsWith('../') || segments.some((segment) => segment.startsWith('.'))) {
    throw new WorkspaceFileError('path_not_allowed', `workspace path is not allowed: ${value}`)
  }
  if (normalized === 'data/agent-workspace' || normalized.startsWith('data/agent-workspace/')) {
    throw new WorkspaceFileError('workspace_prefix_repeated', 'cwd is already data/agent-workspace; remove the data/agent-workspace prefix')
  }
  if (RESERVED_TOP_LEVEL.has(segments[0]!)) {
    throw new WorkspaceFileError('managed_path', `workspace path is managed by a dedicated tool: ${value}`)
  }
  return normalized
}

function validateFilePath(value: string): string {
  const normalized = normalizedRelativePath(value)
  if (!ALLOWED_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    throw new WorkspaceFileError('extension_not_allowed', `workspace file extension is not allowed: ${value}`)
  }
  return normalized
}

async function assertNoSymlinkAncestors(rootDir: string, relativePath: string): Promise<void> {
  let current = resolve(rootDir)
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new WorkspaceFileError('symlink_not_allowed', `symlink path is not allowed: ${relativePath}`)
      if (!info.isDirectory()) throw new WorkspaceFileError('parent_not_directory', `parent is not a directory: ${relativePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function readExistingFile(rootDir: string, relativePath: string): Promise<{ path: string; bytes: Buffer; revision: string }> {
  await assertNoSymlinkAncestors(rootDir, relativePath)
  const path = resolve(rootDir, relativePath)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceFileError('not_found', `workspace file not found: ${relativePath}`)
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new WorkspaceFileError('not_regular_file', `not a regular workspace file: ${relativePath}`)
  if (info.size > MAX_FILE_BYTES) throw new WorkspaceFileError('file_too_large', `workspace file exceeds ${MAX_FILE_BYTES} bytes`)
  const bytes = await readFile(path)
  return { path, bytes, revision: revisionOf(bytes) }
}

async function readExistingDirectory(rootDir: string, relativePath: string): Promise<string> {
  if (!relativePath) return rootDir
  await assertNoSymlinkAncestors(rootDir, `${relativePath}/_`)
  const path = resolve(rootDir, relativePath)
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new WorkspaceFileError('symlink_not_allowed', `symlink path is not allowed: ${relativePath}`)
    if (!info.isDirectory()) throw new WorkspaceFileError('not_directory', `not a workspace directory: ${relativePath}`)
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceFileError('not_found', `workspace directory not found: ${relativePath}`)
    }
    throw error
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(tempPath, bytes)
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

function assertRevision(actual: string, expected: string): void {
  if (actual !== expected) throw new WorkspaceFileError('revision_conflict', 'workspace file changed; read it again and retry')
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceFileError('invalid_text', 'workspace file is not valid UTF-8 text')
  }
}

export function createWorkspaceFileTool(deps: WorkspaceFileToolDeps = {}): Tool<Args> {
  const rootDir = resolve(deps.rootDir ?? DEFAULT_ROOT_DIR)
  return {
    name: 'workspace_file',
    description: [
      '受控维护 Luna 的普通私有文本工作文件.',
      '支持 list/read/write/replace/delete/move; read 返回 revision, 修改已有文件必须携带最新 revision.',
      '修改推荐顺序: 先 read 目标文件, 复制返回的 revision, 再 replace; invoke.args 必须是对象, 不要传 JSON 字符串或空对象.',
      '适合 notes、drafts、creative 等自建目录; notebook/life/memory/skill-drafts/browser 等 managed path 必须走专用工具.',
      'cwd 已经是 data/agent-workspace, 路径不要再带 data/agent-workspace 前缀.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'list') {
          const directory = normalizedRelativePath(args.directory ?? '', true)
          if (directory && RESERVED_TOP_LEVEL.has(directory.split('/')[0]!)) {
            throw new WorkspaceFileError('managed_path', `workspace path is managed by a dedicated tool: ${directory}`)
          }
          const path = await readExistingDirectory(rootDir, directory)
          const names = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') throw new WorkspaceFileError('not_found', `workspace directory not found: ${directory || '.'}`)
            throw error
          })
          const visibleEntries = names
            .filter((entry) => !entry.name.startsWith('.'))
            .filter((entry) => directory || !RESERVED_TOP_LEVEL.has(entry.name))
            .filter((entry) => entry.isDirectory() || (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())))
            .sort((a, b) => a.name.localeCompare(b.name))
          const limit = args.limit ?? 50
          const entries = visibleEntries
            .slice(0, limit)
            .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
          return {
            content: JSON.stringify({
              ok: true,
              action: 'list',
              directory: directory || '.',
              entries,
              total: visibleEntries.length,
              truncated: visibleEntries.length > limit,
            }),
          }
        }

        if (args.action === 'read') {
          const file = validateFilePath(args.file)
          const snapshot = await readExistingFile(rootDir, file)
          const text = decodeText(snapshot.bytes)
          const offset = Math.min(args.offset ?? 0, text.length)
          const content = text.slice(offset, offset + (args.maxChars ?? DEFAULT_READ_CHARS))
          const nextOffset = offset + content.length
          return {
            content: JSON.stringify({
              ok: true,
              action: 'read',
              file,
              revision: snapshot.revision,
              offset,
              content,
              nextOffset: nextOffset < text.length ? nextOffset : null,
              totalChars: text.length,
              truncated: nextOffset < text.length,
            }),
          }
        }

        if (args.action === 'write') {
          const file = validateFilePath(args.file)
          const bytes = Buffer.from(args.content, 'utf8')
          if (bytes.byteLength > MAX_FILE_BYTES) throw new WorkspaceFileError('file_too_large', `workspace file exceeds ${MAX_FILE_BYTES} bytes`)
          await assertNoSymlinkAncestors(rootDir, file)
          const path = resolve(rootDir, file)
          let existing: Awaited<ReturnType<typeof readExistingFile>> | null = null
          try {
            existing = await readExistingFile(rootDir, file)
          } catch (error) {
            if (!(error instanceof WorkspaceFileError) || error.code !== 'not_found') throw error
          }
          if (existing) {
            if (!args.expectedRevision) throw new WorkspaceFileError('revision_required', 'expectedRevision is required when overwriting an existing file')
            assertRevision(existing.revision, args.expectedRevision)
          } else if (args.expectedRevision) {
            throw new WorkspaceFileError('not_found', `workspace file not found: ${file}`)
          }
          await mkdir(dirname(path), { recursive: true })
          await atomicWrite(path, bytes)
          return { content: JSON.stringify({ ok: true, action: 'write', file, revision: revisionOf(bytes), bytes: bytes.byteLength }), outcome: { ok: true } }
        }

        if (args.action === 'replace') {
          const file = validateFilePath(args.file)
          const snapshot = await readExistingFile(rootDir, file)
          assertRevision(snapshot.revision, args.expectedRevision)
          const raw = decodeText(snapshot.bytes)
          const first = raw.indexOf(args.oldText)
          if (first < 0) throw new WorkspaceFileError('text_not_found', 'oldText was not found')
          if (raw.indexOf(args.oldText, first + args.oldText.length) >= 0) {
            throw new WorkspaceFileError('text_not_unique', 'oldText must occur exactly once')
          }
          const content = `${raw.slice(0, first)}${args.newText}${raw.slice(first + args.oldText.length)}`
          const bytes = Buffer.from(content, 'utf8')
          if (bytes.byteLength > MAX_FILE_BYTES) throw new WorkspaceFileError('file_too_large', `workspace file exceeds ${MAX_FILE_BYTES} bytes`)
          await atomicWrite(snapshot.path, bytes)
          return { content: JSON.stringify({ ok: true, action: 'replace', file, revision: revisionOf(bytes) }), outcome: { ok: true } }
        }

        if (args.action === 'delete') {
          const file = validateFilePath(args.file)
          const snapshot = await readExistingFile(rootDir, file)
          assertRevision(snapshot.revision, args.expectedRevision)
          await rm(snapshot.path)
          return { content: JSON.stringify({ ok: true, action: 'delete', file }), outcome: { ok: true } }
        }

        const source = validateFilePath(args.source)
        const destination = validateFilePath(args.destination)
        const snapshot = await readExistingFile(rootDir, source)
        assertRevision(snapshot.revision, args.expectedRevision)
        await assertNoSymlinkAncestors(rootDir, destination)
        const destinationPath = resolve(rootDir, destination)
        try {
          await stat(destinationPath)
          throw new WorkspaceFileError('destination_exists', `destination already exists: ${destination}`)
        } catch (error) {
          if (!(error instanceof WorkspaceFileError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (error instanceof WorkspaceFileError) throw error
        }
        await mkdir(dirname(destinationPath), { recursive: true })
        await rename(snapshot.path, destinationPath)
        return { content: JSON.stringify({ ok: true, action: 'move', source, destination, revision: snapshot.revision }), outcome: { ok: true } }
      } catch (error) {
        const code = error instanceof WorkspaceFileError ? error.code : 'workspace_file_failed'
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: JSON.stringify({ ok: false, code, error: message }),
          outcome: { ok: false, code, error: message },
        }
      }
    },
  }
}

export const workspaceFileTool = createWorkspaceFileTool()
