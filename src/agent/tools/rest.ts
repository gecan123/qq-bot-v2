import { z } from 'zod'
import { createLogger } from '../../logger.js'
import type { BotEvent } from '../event.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const DEFAULT_REST_DURATION_SECONDS = 60
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

const INTENTION_DESCRIPTION = '休息前列 4 到 8 个具体可执行的候选方向; 至少两个能立即用现有工具开始, 等待外部消息最多一个. 醒来后先尝试一个, 不要用“继续看”之类没有对象和动作的占位句.'

const argsSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(MIN_REST_DURATION_SECONDS)
    .max(MAX_REST_DURATION_SECONDS)
    .default(DEFAULT_REST_DURATION_SECONDS)
    .describe('自己安排的休息秒数, 默认 60, 通常 30..120, 范围 30..1800.'),
  intention: z.string().trim().min(1).max(600).describe(INTENTION_DESCRIPTION),
})

type RestArgs = z.infer<typeof argsSchema>

function isAttentionEvent(event: BotEvent): boolean {
  if (event.type === 'napcat_private_message') return true
  if (event.type === 'napcat_message') return event.mentionedSelf
  if (event.type === 'background_task_completed') return true
  if (event.type === 'wake') return true
  return false
}

function restResult(
  status: 'elapsed' | 'interrupted',
  durationSeconds: number,
  elapsedMs: number,
  intention: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify({
      ok: true,
      status,
      durationSeconds,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      intention,
      resumeGuidance: '醒来后先从 intention 里选择并尝试一个具体方向; 没有实际尝试前不要立刻再次休息.',
    }),
    outcome: { ok: true, code: status },
    effects: [{ type: 'pause' }],
  }
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer

  return {
    name: 'rest',
    description: [
      '一段活动确实告一段落时主动安排短暂休息, 默认 1 分钟; 通常选择 30 到 120 秒, 真想离开更久时可自行延长, 最长 30 分钟。',
      'intention 必填, 列 4 到 8 个具体可执行的候选方向; 至少两个能立即用现有工具开始, 它会随休息结果回到上下文。',
      '醒来后先选择并尝试一个方向; 没有实际尝试前不要立刻再次休息。方向不是硬计划, 可按现场情况选择一个、合并几个或改道。',
      '等待外部消息最多只是其中一个候选, 不要只列等待外部消息。',
      '不要用“继续看”“随便逛逛”这类没有对象和动作的句子充当方向。',
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
          return restResult('interrupted', durationSeconds, elapsedMs, args.intention)
        }

        log.info({ elapsedMs }, 'rest_elapsed')
        return restResult('elapsed', durationSeconds, elapsedMs, args.intention)
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
