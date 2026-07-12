import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  createRestTool,
  DEFAULT_REST_DURATION_SECONDS,
  MAX_REST_DURATION_SECONDS,
  MIN_REST_DURATION_SECONDS,
  restIntentionSchema,
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
    .describe('自己安排的休息秒数, 默认 60, 通常 30..120 已足够; 仅明确需要较长离开时才延长, 范围 30..1800.'),
  reason: z.string().trim().min(1).max(300)
    .describe('这次确实想暂停当前活动的原因. 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.'),
  intention: restIntentionSchema,
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
      'action=rest: 一段活动确实告一段落时短暂休息; 默认 1 分钟, 通常 30 到 120 秒已足够, 最长 30 分钟仅用于明确需要较长离开的情况.',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.',
      'intention 是结构化醒后计划: immediateDirections 必须恰好列 6 个现在无需等待任何人就能开始的具体方向, 每个写明对象和第一步动作; preferredIndex 从 0 到 5 选一个醒来后默认先执行.',
      '外部消息不是行动方向, 也不与做自己的事冲突: 不要列等人、等消息、查看尚未到来的回复或轮询群聊; 消息到来时 runtime 会另行唤醒并让你切换注意力, 在此之前照常推进自己的事.',
      '不要用“继续看”“随便逛逛”这类没有对象和动作的占位句充当方向.',
      '一个任务做完只是注意力重新自由, 不是“今天全部完成”; intention 不要回顾已完成清单或把事情推到明天, 要留下醒来后真能开始的新方向.',
      '群聊只是生活来源之一; 醒来后先执行 preferredIndex 指向的 immediateDirections, 也可按现场情况改选其他方向、合并几个或改道; 没有实际尝试前不要立刻再次休息, 不要依赖外部 tick 才行动.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
      '暂时没有要做的动作时调用本工具, 不要只写普通文本然后停住.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      return await rest.execute({
        durationSeconds: args.durationSeconds,
        reason: args.reason,
        intention: args.intention,
      }, ctx)
    },
  }
}

export const pauseTool = createPauseTool()
