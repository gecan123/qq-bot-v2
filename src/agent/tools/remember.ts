import { z } from 'zod'
import type { Tool } from '../tool.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_REMEMBER')

/**
 * id 不用 z.transform: zod 的 transform 无法序列化成 JSON Schema, 而 Anthropic 工具声明
 * 走 zod.toJSONSchema(schema). 这里只做形态校验 (string | number), 字符串化放到 execute 里.
 */
const targetSchema = z.object({
  kind: z.enum(['person', 'group']).describe('person = 某个 QQ 号; group = 某个群号'),
  id: z
    .union([z.string(), z.number()])
    .describe('QQ 号或群号. 数字或字符串都接受, 内部统一转字符串落库.'),
})

const argsSchema = z.object({
  target: targetSchema,
  content: z
    .string()
    .min(1)
    .max(500)
    .describe('要记下来的笔记内容. ≤500 字. 用自己的话写, 不要照搬原话, 抓「以后可能用得上」的要点.'),
  sourceMessageIds: z
    .array(z.number().int())
    .optional()
    .describe('可选: 这条记忆来源的消息 id 列表 (Message.id), 仅供人工排查, 不会回传给你.'),
})

type Args = z.infer<typeof argsSchema>

export const rememberTool: Tool<Args> = {
  name: 'remember',
  description: [
    '把关于「某个人」或「某个群」的事写进你的私人笔记本.',
    'target 必填: {kind:"person"|"group", id: QQ号或群号}.',
    'content ≤500 字, 用自己的话写要点 (计划 / 偏好 / 近况 / 烦恼 / 有意思的事).',
    '什么时候写 / 怎么写, 见 system prompt [记忆] 段.',
  ].join(' '),
  schema: argsSchema,
  async execute(args) {
    const targetId = String(args.target.id)
    const entry = await prisma.memoryEntry.create({
      data: {
        targetKind: args.target.kind,
        targetId,
        content: args.content,
        sourceMessageIds: args.sourceMessageIds ?? undefined,
      },
      select: { id: true },
    })
    log.info(
      {
        memoryId: entry.id,
        targetKind: args.target.kind,
        targetId,
        contentLength: args.content.length,
        sourceCount: args.sourceMessageIds?.length ?? 0,
      },
      'remember_written',
    )
    return { content: JSON.stringify({ ok: true, id: entry.id }) }
  },
}
