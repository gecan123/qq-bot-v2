import { z } from 'zod'
import { createLogger } from '../../logger.js'
import type { BotEvent } from '../event.js'
import type { Tool } from '../tool.js'

const log = createLogger('TOOL_REST')

export const DEFAULT_REST_DURATION_SECONDS = 300
export const MIN_REST_DURATION_SECONDS = 30
export const MAX_REST_DURATION_SECONDS = 1_800

export interface RestToolDeps {
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const defaultTimer = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const argsSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的休息秒数, 默认 300, 范围 30..1800.'),
  intention: z.string().trim().min(1).max(200).describe('醒来后准备继续的事情.'),
})

type RestArgs = z.infer<typeof argsSchema>

function isAttentionEvent(event: BotEvent): boolean {
  if (event.type === 'napcat_private_message') return true
  if (event.type === 'napcat_message') return event.mentionedSelf
  if (event.type === 'background_task_completed') return true
  if (event.type === 'wake') return true
  return false
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer

  return {
    name: 'rest',
    description: [
      '主动安排一次休息, 默认 5 分钟, 最长 30 分钟。',
      'intention 必填, 写清醒来后准备继续的事情; 它会随休息结果回到上下文。',
      '休息期间普通群消息不会打断; 被 @、私聊、后台任务完成或停止信号会立刻唤醒。',
      '事件只用于唤醒, 不会被这个工具消费; 下一轮会正常进入上下文。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const durationSeconds = args.durationSeconds ?? DEFAULT_REST_DURATION_SECONDS
      const durationMs = durationSeconds * 1000
      let timerHandle: unknown = null
      let elapsed = false
      const attentionAbort = new AbortController()

      log.info({ durationSeconds, intention: args.intention }, 'rest_enter')
      const startedAt = Date.now()

      const timeoutPromise = new Promise<'elapsed'>((resolve) => {
        timerHandle = timer.setTimeout(() => {
          elapsed = true
          resolve('elapsed')
        }, durationMs)
      })

      try {
        const result = await Promise.race([
          ctx.eventQueue
            .waitForEventWhere(isAttentionEvent, { signal: attentionAbort.signal })
            .then(() => 'interrupted' as const),
          timeoutPromise,
        ])
        const elapsedMs = Date.now() - startedAt

        if (result === 'interrupted') {
          log.info({ elapsedMs }, 'rest_interrupted')
          return {
            content: `[休息被打断] 收到需要注意的新事件, 下一轮先处理事件; 原计划: ${args.intention}`,
          }
        }

        log.info({ elapsedMs }, 'rest_elapsed')
        return { content: `[休息结束] 已休息约 ${durationSeconds} 秒。继续: ${args.intention}` }
      } finally {
        attentionAbort.abort()
        if (!elapsed && timerHandle != null) {
          timer.clearTimeout(timerHandle)
        }
      }
    },
  }
}

export const restTool = createRestTool()
