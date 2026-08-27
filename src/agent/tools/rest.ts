import { z } from 'zod'
import { createLogger } from '../../logger.js'
import { isAttentionEvent } from '../notification.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const MIN_REST_DURATION_MINUTES = 10
export const DEFAULT_REST_DURATION_MINUTES = 30
export const MAX_REST_DURATION_MINUTES = 30
export const REST_COOLDOWN_MINUTES = 60
const MINUTE_MS = 60_000

const argsSchema = z.object({
  durationMinutes: z.number().int().min(MIN_REST_DURATION_MINUTES).max(MAX_REST_DURATION_MINUTES)
    .default(DEFAULT_REST_DURATION_MINUTES)
    .describe('期望休息分钟数，默认 30，范围 10..30；完成一次休息后 60 分钟内不能再次主动休息。'),
  reason: z.string().trim().min(1).max(300)
    .describe('为什么此刻真正想暂停；疲惫、需要沉淀、没有具体牵引力或正在机械重复都可以是理由。'),
  resumeAction: z.string().trim().min(1).max(300)
    .describe('醒后先重新评估的方向或检查点；不是必须立即执行的承诺。'),
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
  let lastCompletedRestAtMs: number | null = null

  return {
    name: 'rest',
    description: [
      '唯一的主动休息入口。真正想休息、放空、沉淀，或发现自己正在机械重复时直接调用；不需要先制造任务来证明有资格停下。',
      '默认请求 30 分钟，范围 10..30；一次休息完整结束后进入 60 分钟进程内冷却，冷却期间不要再次调用或创建 Schedule 等待。',
      '冷却结果不会披露剩余时间，避免围绕休息资格反复检查。冷却不跨重启持久化。',
      '私聊、@、后台任务完成、调度事件或 runtime 停止信号会提前打断休息，事件不会被本工具消费；被打断的休息不启动冷却。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const requestedDurationMinutes = args.durationMinutes ?? DEFAULT_REST_DURATION_MINUTES
      const startedAt = now()
      if (
        lastCompletedRestAtMs != null
        && startedAt - lastCompletedRestAtMs < REST_COOLDOWN_MINUTES * MINUTE_MS
      ) {
        const error = '最近已经完成过一次休息，本轮不要再次围绕休息做决定；不要创建 Schedule 等待冷却。'
        log.info({ requestedDurationMinutes }, 'rest_cooldown_active')
        return {
          content: JSON.stringify({
            ok: false,
            code: 'rest_recently_used',
            error,
          }),
          outcome: {
            ok: false,
            code: 'rest_recently_used',
            error,
            progress: false,
            continuation: 'backoff',
            continuationDetail: '最近已经休息过，短暂退避后选择休息之外的具体方向',
          },
        }
      }

      const durationMinutes = requestedDurationMinutes
      const durationMs = durationMinutes * MINUTE_MS
      const attentionAbort = new AbortController()
      let timerHandle: unknown = null
      let elapsed = false

      log.info({
        requestedDurationMinutes,
        durationMinutes,
        reason: args.reason,
        resumeAction: args.resumeAction,
      }, 'rest_started')
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
        const finishedAt = now()
        if (status === 'elapsed') lastCompletedRestAtMs = finishedAt
        log.info({
          status,
          durationMinutes,
          elapsedMs: Math.max(0, finishedAt - startedAt),
        }, 'rest_finished')
        return restResult(
          status,
          requestedDurationMinutes,
          durationMinutes,
          args.reason,
          args.resumeAction,
        )
      } finally {
        attentionAbort.abort()
        if (!elapsed && timerHandle != null) timer.clearTimeout(timerHandle)
      }
    },
  }
}

function restResult(
  status: 'elapsed' | 'interrupted',
  requestedDurationMinutes: number,
  durationMinutes: number,
  reason: string,
  resumeAction: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify({
      ok: true,
      status,
      requestedDurationMinutes,
      durationMinutes,
      reason,
      resumeAction,
    }),
    outcome: {
      ok: true,
      code: status === 'elapsed' ? 'rest_elapsed' : 'rest_interrupted',
      progress: false,
      continuation: 'immediate',
      continuationDetail: status === 'elapsed'
        ? '主动休息结束，重新评估是否有值得推进的具体方向'
        : '主动休息被注意事件打断，先处理注意事件；处理后可再次按需要调用 rest',
    },
  }
}

export const restTool = createRestTool()
