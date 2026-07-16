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
    .describe('自己安排的短休息秒数, 默认 60, 范围 30..600.'),
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
      'action=rest: 确实想暂时停一下时短休息; 默认 1 分钟, 最长 10 分钟. 它是安全阀, 不是空闲默认动作.',
      'reason 只说明为什么此刻确实想暂停; 时间晚、owner 不在线、群聊与自己无关或刚完成一件事, 单独都不是充分理由.',
      '没有未处理义务或真实牵引力时直接结束当前活动轮, runtime 会自然等待; 不要为了收尾调用 pause.',
      '调用 pause 表示此刻确实选择短暂休息, 会立即进入计时, 不再同步请求额外的 LLM 判断.',
      'intention 只写一个具体 primaryDirection 和一个不同的 alternativeDirection, 都必须写明对象和第一步; 不要制造六项菜单.',
      '等消息、轮询群聊、机械盯行情、泛泛浏览站点或整理 memory/journal 都不是行动方向; 未来时点再看行情用 schedule.',
      '一个任务做完后重新评估: 有真实后续就继续, 没有未处理义务或牵引力就结束当前活动轮; 不要用发消息、写 Journal 或再次休息表演收尾.',
      '休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
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
