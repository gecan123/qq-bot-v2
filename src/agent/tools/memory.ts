import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  deleteMemoryFiles,
  listMemoryFiles,
  readMemoryFile,
  searchMemoryEntries,
  writeMemoryEntry,
  type MemoryScope,
} from '../memory-store.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_MEMORY')

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'

const scopeSchema = z.enum(['self', 'person', 'group', 'topic'])
const idSchema = z.union([z.string(), z.number()])
const memoryFileSchema = z.string().trim().min(1).max(200).refine(
  (file) => file.endsWith('.md')
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').includes('..'),
  '必须是 memory 内的 .md 相对路径',
)

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条长期记忆.'),
    scope: scopeSchema.describe('记忆范围: self=自己做事/经验, person=某个 QQ 用户, group=某个群, topic=某个主题.'),
    id: idSchema.optional().describe('person/group 需要: QQ 号或群号. topic/self 通常不需要.'),
    title: z.string().trim().min(1).max(80).optional().describe('self/topic 可选: 文件主题标题.'),
    content: z.string().trim().min(1).max(500).describe('要记下来的内容. ≤500 字, 用自己的话写, 一条记一件事.'),
    sourceMessageIds: z.array(z.number().int()).optional().describe('可选: 来源 Message.id 列表, 仅供人工排查.'),
  }),
  z.object({
    action: z.literal('search').describe('搜索长期记忆.'),
    scope: scopeSchema.optional().describe('可选: 限定搜索范围.'),
    keyword: z.string().trim().min(1).max(100).optional().describe('可选: 关键词. 不传则按更新时间返回最近文件摘要.'),
    limit: z.number().int().min(1).max(20).optional().describe('可选: 最多返回多少条 (1-20, 默认 10).'),
  }),
  z.object({
    action: z.literal('read').describe('读取某个记忆文件.'),
    file: z.string().trim().min(1).max(200).describe('search/write 返回的相对文件路径, 例如 self/working-notes.md.'),
  }),
  z.object({
    action: z.literal('list').describe('列出记忆文件元数据, 不返回正文.'),
    scope: scopeSchema.optional().describe('可选: 限定记忆范围.'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回多少个文件 (1-100, 默认 50).'),
  }),
  z.object({
    action: z.literal('delete').describe('永久删除明确指定的记忆文件.'),
    files: z.array(memoryFileSchema).min(1).max(50).describe('要永久删除的 1-50 个 memory 相对路径.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface MemoryToolDeps {
  workspaceDir?: string
  now?: () => Date
}

export function createMemoryTool(deps: MemoryToolDeps = {}): Tool<Args> {
  const workspaceDir = deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR

  return {
    name: 'memory',
    description: [
      '本地 Markdown 长期记忆库, 一个入口用 action 决定动作.',
      'action=write: 写入以后可能用得上的真实信息或经验; scope=self/person/group/topic.',
      'action=search: 搜索自己、人物、群或主题记忆; 不确定旧事、偏好、项目线索或自己做过什么时先查.',
      'action=read: 读取 search/write 返回的某个记忆文件; 只在需要深读时使用.',
      'action=list: 按 scope 列出有界文件元数据, 用于发现重复或过时记忆.',
      'action=delete: 永久删除明确指定的记忆文件; 先确认有价值内容已写入保留版本.',
      'person/group 写入需要 id; self/topic 可用 title 表示主题.',
      '写入要用自己的话, 不要照搬原话; 查询结果用于自然说话, 不要像报数据库.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'write') {
          const result = await writeMemoryEntry(
            { rootDir: workspaceDir, now: deps.now },
            {
              scope: args.scope as MemoryScope,
              id: args.id == null ? undefined : String(args.id),
              title: args.title,
              content: args.content,
              sourceMessageIds: args.sourceMessageIds,
            },
          )
          log.info({
            file: result.file,
            scope: result.scope,
            title: result.title,
            contentLength: args.content.length,
            sourceCount: args.sourceMessageIds?.length ?? 0,
          }, 'memory_written')
          return { content: JSON.stringify(result) }
        }

        if (args.action === 'search') {
          const result = await searchMemoryEntries(
            { rootDir: workspaceDir },
            { scope: args.scope, keyword: args.keyword, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            keyword: args.keyword ?? null,
            limit: args.limit ?? null,
            hitCount: result.matches.length,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_searched')
          return { content: JSON.stringify(result) }
        }

        if (args.action === 'list') {
          const result = await listMemoryFiles(
            { rootDir: workspaceDir },
            { scope: args.scope, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            limit: args.limit ?? null,
            fileCount: result.files.length,
            total: result.total,
            truncated: result.truncated,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_listed')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'delete') {
          const result = await deleteMemoryFiles(
            { rootDir: workspaceDir },
            { files: args.files },
          )
          log.info({
            requestedFiles: args.files,
            deletedCount: result.deleted.length,
            missingCount: result.missing.length,
            failedCount: result.failed.length,
          }, 'memory_deleted')
          return {
            content: JSON.stringify(result),
            outcome: result.ok
              ? { ok: true }
              : { ok: false, code: 'delete_failed', error: '部分记忆文件删除失败' },
          }
        }

        const result = await readMemoryFile({ rootDir: workspaceDir }, { file: args.file })
        return { content: JSON.stringify(result) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err }, 'memory_tool_failed')
        return { content: JSON.stringify({ ok: false, error: message }) }
      }
    },
  }
}

export const memoryTool: Tool<Args> = createMemoryTool()
