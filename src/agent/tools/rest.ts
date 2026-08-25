import { z } from 'zod'
import { createLogger } from '../../logger.js'
import { isAttentionEvent } from '../notification.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const DEFAULT_REST_DURATION_MINUTES = 10
export const MAX_REST_DURATION_MINUTES = 60
export const REST_COOLDOWN_MINUTES = 60
const MINUTE_MS = 60_000

const argsSchema = z.object({
  durationMinutes: z.number().int().min(1).max(MAX_REST_DURATION_MINUTES)
    .default(DEFAULT_REST_DURATION_MINUTES)
    .describe('主动休息分钟数，默认 10，范围 1..60。'),
  reason: z.string().trim().min(1).max(300)
    .describe('为什么此刻真正想主动休息；完成一件事、暂时没想法或在等回复都不是休息理由。'),
  resumeAction: z.string().trim().min(1).max(300)
    .describe('休息结束或被打断后要立即开始的一个具体动作。'),
}).strict()

type RestArgs = z.infer<typeof argsSchema>

export interface RestToolDeps {
  timer?: {
    setTimeout: (callback: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  now?: () => number
}

const defaultTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer
  const now = deps.now ?? Date.now
  let nextRestAllowedAtMs = 0

  return {
    name: 'rest',
    description: [
      '唯一的主动休息入口。只有此刻真正想暂停活动时才调用；完成任务、暂时没想法、owner 不在线或等待外部回复都不是休息理由。',
      '其他情况下必须直接选择下一件可执行的事继续行动，可以研究、创作、聊天、维护自己的项目或探索网络。',
      '默认休息 10 分钟，最长 1 小时；必须写明真实 reason 和醒后立即执行的 resumeAction。',
      '每次休息结束或被打断后有 60 分钟冷却，冷却期间不能再次休息，必须去做其他事情。',
      '私聊、@、后台任务完成、调度事件或 runtime 停止信号会提前打断休息，事件不会被本工具消费。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const requestedAt = now()
      if (requestedAt < nextRestAllowedAtMs) {
        const retryAfterMinutes = Math.ceil((nextRestAllowedAtMs - requestedAt) / MINUTE_MS)
        const error = `休息冷却中，还需至少 ${retryAfterMinutes} 分钟；现在选择一个非 rest 的具体行动。`
        log.info({ retryAfterMinutes }, 'rest_rejected_cooldown')
        return {
          content: JSON.stringify({
            ok: false,
            code: 'rest_cooldown',
            retryAfterMinutes,
            error,
          }),
          outcome: {
            ok: false,
            code: 'rest_cooldown',
            error,
            progress: false,
          },
        }
      }
      const durationMinutes = args.durationMinutes ?? DEFAULT_REST_DURATION_MINUTES
      const durationMs = durationMinutes * MINUTE_MS
      const startedAt = requestedAt
      const attentionAbort = new AbortController()
      let timerHandle: unknown = null
      let elapsed = false

      log.info({ durationMinutes, reason: args.reason, resumeAction: args.resumeAction }, 'rest_started')
      try {
        const status = await Promise.race([
          ctx.eventQueue
            .waitForEventWhere(isAttentionEvent, { signal: attentionAbort.signal })
            .then(() => 'interrupted' as const),
          new Promise<'elapsed'>((resolve) => {
            timerHandle = timer.setTimeout(() => {
              elapsed = true
              resolve('elapsed')
            }, durationMs)
          }),
        ])
        log.info({
          status,
          durationMinutes,
          elapsedMs: Math.max(0, now() - startedAt),
        }, 'rest_finished')
        nextRestAllowedAtMs = now() + REST_COOLDOWN_MINUTES * MINUTE_MS
        return restResult(status, durationMinutes, args.reason, args.resumeAction)
      } finally {
        attentionAbort.abort()
        if (!elapsed && timerHandle != null) timer.clearTimeout(timerHandle)
      }
    },
  }
}

function restResult(
  status: 'elapsed' | 'interrupted',
  durationMinutes: number,
  reason: string,
  resumeAction: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify({ ok: true, status, durationMinutes, reason, resumeAction }),
    outcome: {
      ok: true,
      code: status === 'elapsed' ? 'rest_elapsed' : 'rest_interrupted',
      progress: false,
      continuation: 'immediate',
      continuationDetail: status === 'elapsed'
        ? '主动休息结束，立即执行醒后方向'
        : '主动休息被注意事件打断，立即重新决定下一步',
    },
  }
}

export const restTool = createRestTool()
