import { z } from 'zod'
import { createLogger } from '../../logger.js'
import { isAttentionEvent } from '../notification.js'
import type { Tool, ToolExecutionResult } from '../tool.js'

const log = createLogger('TOOL_REST')

export const MIN_REST_DURATION_MINUTES = 10
export const DEFAULT_REST_DURATION_MINUTES = 30
export const MAX_REST_DURATION_MINUTES = 120
export const REST_WINDOW_MINUTES = 180
export const DAY_REST_LIMIT_MINUTES = 60
export const NIGHT_REST_LIMIT_MINUTES = 120
export const REST_TIME_ZONE = 'Asia/Singapore'
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const NIGHT_END_HOUR = 6

interface RestInterval {
  startedAtMs: number
  endedAtMs: number
}

export interface RestBudgetDecision {
  period: 'day' | 'night'
  requestedDurationMinutes: number
  grantedDurationMinutes: number
}

export interface RestBudget {
  authorize: (requestedDurationMinutes: number, nowMs: number) => RestBudgetDecision
  record: (startedAtMs: number, endedAtMs: number) => void
}

const argsSchema = z.object({
  durationMinutes: z.number().int().min(MIN_REST_DURATION_MINUTES).max(MAX_REST_DURATION_MINUTES)
    .default(DEFAULT_REST_DURATION_MINUTES)
    .describe('期望休息分钟数，默认 30，范围 10..120；实际批准时长受最近三小时滚动额度和昼夜边界限制。'),
  reason: z.string().trim().min(1).max(300)
    .describe('为什么此刻真正想暂停；疲惫、需要沉淀、没有具体牵引力或正在机械重复都可以是理由。'),
  resumeAction: z.string().trim().min(1).max(300)
    .describe('醒后先检查的具体方向或检查点；休息自然结束后必须先完成一次有界方向搜索，不能立即再次休息。'),
}).strict()

type RestArgs = z.infer<typeof argsSchema>

export interface RestToolDeps {
  timer?: {
    setTimeout: (callback: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  now?: () => number
  budget?: RestBudget
}

const defaultTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) as unknown,
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createRestTool(deps: RestToolDeps = {}): Tool<RestArgs> {
  const timer = deps.timer ?? defaultTimer
  const now = deps.now ?? Date.now
  const budget = deps.budget ?? createRestBudget()

  return {
    name: 'rest',
    description: [
      '唯一的主动休息入口。真正想休息、放空、沉淀，或发现自己正在机械重复时直接调用；不需要先制造任务来证明有资格停下。',
      '完成任务本身不自动等于需要休息；但做过一次有界方向搜索后仍没有真正想做、值得做的事，也不要为了显得忙碌而强行行动。',
      '休息自然结束后，Runtime 会要求先完成一次有界方向搜索，并暂时拒绝再次 rest；获得真实新证据或改变可观察状态后才解除该限制。',
      '默认请求 30 分钟，范围 10..120；最近三小时白天 06:00..24:00 最多累计休息 60 分钟，夜间 00:00..06:00 最多 120 分钟，按 Asia/Singapore 计算。',
      '工具会按剩余额度缩短时长，并在 00:00 或 06:00 边界结束后重新评估；额度不足 10 分钟时拒绝并短暂退避，不要连续重试或另建 Schedule 等待。',
      '私聊、@、后台任务完成、调度事件或 runtime 停止信号会提前打断休息，事件不会被本工具消费。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const requestedDurationMinutes = args.durationMinutes ?? DEFAULT_REST_DURATION_MINUTES
      const startedAt = now()
      const decision = budget.authorize(requestedDurationMinutes, startedAt)
      const durationMinutes = decision.grantedDurationMinutes
      if (durationMinutes < MIN_REST_DURATION_MINUTES) {
        const error = '最近三小时的休息额度暂时不足以开始至少 10 分钟的休息；不要连续重试或创建 Schedule 等待。'
        log.info({ ...decision }, 'rest_budget_exhausted')
        return {
          content: JSON.stringify({
            ok: false,
            code: 'rest_budget_exhausted',
            period: decision.period,
            error,
          }),
          outcome: {
            ok: false,
            code: 'rest_budget_exhausted',
            error,
            progress: false,
            continuation: 'backoff',
            continuationDetail: '主动休息额度暂时不足，短暂退避后重新评估，不要用工具调用填满等待时间',
          },
        }
      }
      const durationMs = durationMinutes * MINUTE_MS
      const attentionAbort = new AbortController()
      let timerHandle: unknown = null
      let elapsed = false

      log.info({
        ...decision,
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
        log.info({
          status,
          durationMinutes,
          elapsedMs: Math.max(0, now() - startedAt),
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
        budget.record(startedAt, now())
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

export function createRestBudget(): RestBudget {
  let intervals: RestInterval[] = []

  return {
    authorize(requestedDurationMinutes, nowMs) {
      const windowStartMs = nowMs - REST_WINDOW_MINUTES * MINUTE_MS
      intervals = intervals.filter(interval => interval.endedAtMs > windowStartMs)
      const usedMs = intervals.reduce((total, interval) => {
        const overlapStart = Math.max(interval.startedAtMs, windowStartMs)
        const overlapEnd = Math.min(interval.endedAtMs, nowMs)
        return total + Math.max(0, overlapEnd - overlapStart)
      }, 0)
      const localTime = localTimeOfDay(nowMs)
      const period = localTime.hour < NIGHT_END_HOUR ? 'night' : 'day'
      const limitMinutes = period === 'night'
        ? NIGHT_REST_LIMIT_MINUTES
        : DAY_REST_LIMIT_MINUTES
      const remainingBudgetMinutes = Math.max(
        0,
        Math.floor((limitMinutes * MINUTE_MS - usedMs) / MINUTE_MS),
      )
      const untilBoundaryMinutes = Math.max(
        0,
        Math.floor(millisecondsUntilBoundary(localTime) / MINUTE_MS),
      )

      return {
        period,
        requestedDurationMinutes,
        grantedDurationMinutes: Math.min(
          requestedDurationMinutes,
          remainingBudgetMinutes,
          untilBoundaryMinutes,
        ),
      }
    },
    record(startedAtMs, endedAtMs) {
      if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return
      if (endedAtMs <= startedAtMs) return
      intervals.push({ startedAtMs, endedAtMs })
    },
  }
}

function localTimeOfDay(nowMs: number): { hour: number; minute: number; second: number; millisecond: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REST_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const values = new Map(parts.map(part => [part.type, part.value]))
  return {
    hour: Number(values.get('hour')) % 24,
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
    millisecond: ((nowMs % 1000) + 1000) % 1000,
  }
}

function millisecondsUntilBoundary(localTime: ReturnType<typeof localTimeOfDay>): number {
  const elapsedMs = localTime.hour * HOUR_MS
    + localTime.minute * MINUTE_MS
    + localTime.second * 1000
    + localTime.millisecond
  const boundaryMs = localTime.hour < NIGHT_END_HOUR ? NIGHT_END_HOUR * HOUR_MS : DAY_MS
  return boundaryMs - elapsedMs
}

export const restTool = createRestTool()
