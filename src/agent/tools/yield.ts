import { z } from 'zod'
import type { Tool } from '../tool.js'

const argsSchema = z.object({
  reason: z.string().trim().min(1).max(300).optional()
    .describe('可选：为什么当前没有值得继续执行的动作。'),
}).strict()

type Args = z.infer<typeof argsSchema>

export function createYieldTool(): Tool<Args> {
  return {
    name: 'yield',
    description: '当前没有值得继续执行的动作时结束本轮并把控制权交回 runtime。它立即返回，不计时、不保存恢复计划；新消息、后台完成或其他注意事件会自然触发下一轮。',
    schema: argsSchema,
    async execute(args) {
      return {
        content: JSON.stringify({
          ok: true,
          status: 'yielded',
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        }),
        outcome: {
          ok: true,
          code: 'yielded',
          progress: false,
          continuation: 'stop',
        },
      }
    },
  }
}

export const yieldTool = createYieldTool()
