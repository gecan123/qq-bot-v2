import { z } from 'zod'
import type { Tool } from '../tool.js'
import { rememberTool } from './remember.js'
import { recallTool } from './recall.js'

const targetSchema = z.object({
  kind: z.enum(['person', 'group']).describe('person = 某个 QQ 号; group = 某个群号'),
  id: z.union([z.string(), z.number()]).describe('QQ 号或群号. 数字或字符串都接受.'),
})

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条私人笔记.'),
    target: targetSchema,
    content: z
      .string()
      .min(1)
      .max(500)
      .describe('要记下来的笔记内容. ≤500 字. 用自己的话写, 一条记一件事.'),
    sourceMessageIds: z
      .array(z.number().int())
      .optional()
      .describe('可选: 这条记忆来源的 Message.id 列表, 仅供人工排查.'),
  }),
  z.object({
    action: z.literal('search').describe('查询私人笔记.'),
    target: targetSchema,
    keyword: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('可选: 关键词. 精确子串匹配 (大小写不敏感). 不传则按时间倒序返回最近笔记.'),
    limit: z.number().int().min(1).max(20).optional().describe('可选: 最多返回多少条 (1-20, 默认 10).'),
  }),
])

type Args = z.infer<typeof argsSchema>

export const memoryTool: Tool<Args> = {
  name: 'memory',
  description: [
    '私人笔记工具, 一个入口用 action 决定动作.',
    'action=write: 把关于某个人或某个群的真实信息写入私人笔记; 只记以后可能用得上的事.',
    'action=search: 翻出关于某个人或某个群的旧笔记; 聊到具体人/群、旧话题、偏好或关系细节时不确定就先查.',
    'target 必填: {kind:"person"|"group", id: QQ号或群号}.',
    '写入要用自己的话, 不要照搬原话; 查询结果用于自然说话, 不要像报数据库.',
  ].join(' '),
  schema: argsSchema,
  async execute(args, ctx) {
    if (args.action === 'write') {
      return await rememberTool.execute({
        target: args.target,
        content: args.content,
        sourceMessageIds: args.sourceMessageIds,
      }, ctx)
    }
    return await recallTool.execute({
      target: args.target,
      keyword: args.keyword,
      limit: args.limit,
    }, ctx)
  },
}
