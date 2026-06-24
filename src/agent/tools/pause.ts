import { z } from 'zod'
import type { Tool } from '../tool.js'
import { createRestTool, type RestToolDeps } from './rest.js'

const DEFAULT_REST_DURATION_SECONDS = 30
const MAX_REST_DURATION_SECONDS = 300

const argsSchema = z.object({
  action: z.literal('rest').describe('主动短暂休息, 普通群消息不打断.'),
  durationSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('休息秒数, 默认 30, 最大 300.'),
  reason: z.string().optional().describe('此刻为什么休息的简短说明, 仅用于日志.'),
})

type Args = z.infer<typeof argsSchema>

export interface PauseToolDeps {
  rest?: RestToolDeps
}

export function createPauseTool(deps: PauseToolDeps = {}): Tool<Args> {
  const rest = createRestTool(deps.rest)

  return {
    name: 'pause',
    description: [
      '对话节奏控制工具.',
      'action=rest: 主动短暂休息; 默认约 30 秒后醒来.',
      '醒来后优先找事做; 只有仍然没有真实锚点或任务时才继续休息.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
      '暂时没有要做的动作时调用本工具, 不要只写普通文本然后停住.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      return await rest.execute({ durationSeconds: args.durationSeconds, reason: args.reason }, ctx)
    },
  }
}

export const pauseTool = createPauseTool()
