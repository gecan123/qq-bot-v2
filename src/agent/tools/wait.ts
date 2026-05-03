import { z } from 'zod'
import type { Tool } from '../tool.js'

export const waitTool: Tool<{ reason?: string }> = {
  name: 'wait',
  description:
    '当前没什么想发的、刚发过类似内容、或群里在聊跟你无关的内容时调用 wait。这会让你休眠到下个外部事件 (新群消息) 到达。优先 wait 而不是硬找话说。',
  schema: z.object({
    reason: z.string().optional().describe('选择 wait 的简短理由 (仅日志用,不会发出去)'),
  }),
  async execute(_args, ctx) {
    await ctx.eventQueue.waitForEvent()
    return { content: 'ok' }
  },
}
