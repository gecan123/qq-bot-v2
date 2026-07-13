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
    .describe('自己安排的短休息秒数, 默认 60, 范围 30..300.'),
  confirmed: z.boolean().default(false)
    .describe('第一次请求必须为 false. 仅当前一次 pause 已返回 alternative_available、此后没有别的工具结果且你仍真想休息时, 再次调用并设为 true.'),
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
      'action=rest: 确实想暂时停一下时短休息; 默认 1 分钟, 最长 5 分钟. 它是安全阀, 不是空闲默认动作.',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.',
      '第一次调用 confirmed=false; 若返回 alternative_available, 说明没有暂停. 看过建议后仍真想休息, 才再次调用并设 confirmed=true.',
      'intention 只写一个具体 primaryDirection 和一个不同的 alternativeDirection, 都必须写明对象和第一步; 不要制造六项菜单.',
      '等消息、轮询群聊、机械盯行情、泛泛浏览站点或整理 memory/journal 都不是行动方向; 未来时点再看行情用 schedule.',
      '一个任务做完只是注意力重新自由, 不是“今天全部完成”; 没有实际尝试醒后方向前不要立刻再次休息.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      return await rest.execute({
        durationSeconds: args.durationSeconds,
        confirmed: args.confirmed,
        reason: args.reason,
        intention: args.intention,
      }, ctx)
    },
  }
}

export const pauseTool = createPauseTool()
