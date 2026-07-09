import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  createRestTool,
  DEFAULT_REST_DURATION_SECONDS,
  MAX_REST_DURATION_SECONDS,
  MIN_REST_DURATION_SECONDS,
  type RestToolDeps,
} from './rest.js'

const argsSchema = z.object({
  action: z.literal('rest').describe('主动短暂休息, 普通群消息不打断.'),
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的休息秒数, 默认 300, 范围 30..1800.'),
  intention: z.string().trim().min(1).max(200)
    .describe('休息前给自己列 4 到 8 个可选方向; 醒来后可按现场情况选择一个、合并几个或改道.'),
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
      'action=rest: 自己安排休息时长, 并在 intention 简短列 4 到 8 个可选方向; 默认 5 分钟, 最长 30 分钟.',
      '群聊只是生活来源之一; 醒来后优先找事做, 按 intention 选择一个、合并几个或改道继续自己的事; 只有仍然没有真实锚点或任务时才继续休息, 不要依赖外部 tick 才行动.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
      '暂时没有要做的动作时调用本工具, 不要只写普通文本然后停住.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      return await rest.execute({
        durationSeconds: args.durationSeconds,
        intention: args.intention,
      }, ctx)
    },
  }
}

export const pauseTool = createPauseTool()
