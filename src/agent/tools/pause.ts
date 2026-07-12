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
    .describe('自己安排的休息秒数, 默认 60, 通常 30..120, 范围 30..1800.'),
  intention: z.string().trim().min(1).max(600)
    .describe('休息前列 4 到 8 个具体可执行的候选方向; 至少两个能立即用现有工具开始, 等待外部消息最多一个. 醒来后先尝试一个; 不要用已完成事项回顾、“今天全部完成”或“明天继续”代替候选方向, 也不要写“继续看”之类占位句.'),
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
      'action=rest: 一段活动确实告一段落时短暂休息; 默认 1 分钟, 通常 30 到 120 秒, 真想离开更久时可自行延长, 最长 30 分钟.',
      '在 intention 列 4 到 8 个具体可执行方向, 至少两个能立即用现有工具开始; 不要写“继续看”“随便逛逛”这类占位句.',
      '一个任务做完只是注意力重新自由, 不是“今天全部完成”; intention 不要回顾已完成清单或把事情推到明天, 要留下醒来后真能开始的新方向.',
      '群聊只是生活来源之一; 醒来后优先按 intention 选择并尝试一个、合并几个或改道继续自己的事; 没有实际尝试前不要立刻再次休息, 不要依赖外部 tick 才行动.',
      '等待外部消息最多只是其中一个候选, 不要只列等待外部消息。',
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
