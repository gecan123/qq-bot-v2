import { z } from 'zod'
import type { Tool } from '../tool.js'
import { createRestTool, type RestToolDeps } from './rest.js'
import { createWaitTool, type WaitToolDeps } from './wait.js'

const DEFAULT_REST_DURATION_SECONDS = 30
const MAX_REST_DURATION_SECONDS = 300

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('wait').describe('等到下个外部事件; 长时间无事件会返回空闲提示.'),
    reason: z.string().optional().describe('此刻的心情或状态速写, 仅日志, 不会发出去.'),
  }),
  z.object({
    action: z.literal('rest').describe('主动短暂休息, 普通群消息不打断.'),
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_REST_DURATION_SECONDS)
      .default(DEFAULT_REST_DURATION_SECONDS)
      .describe('休息秒数, 默认 30, 最大 300.'),
    reason: z.string().optional().describe('此刻为什么休息的简短说明, 仅用于日志.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface PauseToolDeps {
  wait?: WaitToolDeps
  rest?: RestToolDeps
}

export function createPauseTool(deps: PauseToolDeps = {}): Tool<Args> {
  const wait = createWaitTool(deps.wait)
  const rest = createRestTool(deps.rest)

  return {
    name: 'pause',
    description: [
      '对话节奏控制工具, 一个入口用 action 决定动作.',
      'action=wait: 没有要做的动作时等待下个外部事件; 长时间无事件会返回 [空闲提示], 这是自由活动入口, 不是要回复的对象.',
      'action=rest: 主动短暂休息; 休息期间普通群消息不会打断, 被 @、私聊、后台任务完成或停止信号会立刻唤醒.',
      '没有要做的动作时必须调用本工具, 不要只写普通文本然后停住.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = argsSchema.parse(rawArgs)
      if (args.action === 'wait') {
        return await wait.execute({ reason: args.reason }, ctx)
      }
      return await rest.execute({ durationSeconds: args.durationSeconds, reason: args.reason }, ctx)
    },
  }
}

export const pauseTool = createPauseTool()
