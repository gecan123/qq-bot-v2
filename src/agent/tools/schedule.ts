import { z } from 'zod'
import {
  ScheduleRuntimeError,
  type ScheduleRuntime,
} from '../schedule-runtime.js'
import { SCHEDULE_LIMITS, type ScheduleSpec } from '../schedule-model.js'
import type { ScheduleJob } from '../schedule-store.js'
import type { Tool, ToolExecutionResult } from '../tool.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const atAbsoluteSchema = z.object({
  kind: z.literal('at'),
  at: z.string().trim().min(1).max(100)
    .describe('带时区的未来时间字符串；与 afterSeconds 二选一。'),
}).strict()

const atRelativeSchema = z.object({
  kind: z.literal('at'),
  afterSeconds: z.number().int().min(30).max(3 * 24 * 60 * 60)
    .describe('从现在起多久后唤醒，范围 30..259200 秒；与 at 二选一。'),
}).strict()

const everySchema = z.object({
  kind: z.literal('every'),
  everySeconds: z.number().int().min(5 * 60)
    .describe('固定周期秒数，至少 300 秒。'),
  anchorAt: z.string().trim().min(1).max(100).optional()
    .describe('可选的带时区锚点；省略时以创建时间为锚点。'),
}).strict()

const cronSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().trim().min(1).max(200)
    .describe('cron 表达式。相邻触发必须至少间隔 5 分钟。'),
  timezone: z.string().trim().min(1).max(100).optional()
    .describe('可选 IANA 时区；默认 Asia/Shanghai。'),
}).strict()

const scheduleSchema = z.union([
  atAbsoluteSchema,
  atRelativeSchema,
  everySchema,
  cronSchema,
])

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength)
      .describe('活跃调度的唯一名称；同名同定义会返回 existing。'),
    intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength)
      .describe('到期后要结合最新 Goal、消息和环境重新判断的注意事项，不是未来命令。'),
    schedule: scheduleSchema,
    maxRuns: z.number().int().positive().optional()
      .describe('可选最大触发次数；at 通常为 1。'),
  }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    action: z.literal('get_occurrence'),
    scheduleId: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
    runCount: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal('cancel'),
    id: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
  }).strict(),
])

type Args = z.infer<typeof argsSchema>

export function createScheduleTool(runtime: ScheduleRuntime): Tool<Args> {
  return {
    name: 'schedule',
    description: [
      '管理最长 3 天、可跨重启恢复的短期注意力唤醒，支持 at、every 和 cron；最多 20 个活跃调度。',
      '到期只注入不含 intention 正文的 notification；用通知给出的 get_occurrence 参数按需读取，再结合最新 Goal、消息和环境重新判断。',
      'cron 默认时区为 Asia/Shanghai，周期至少 5 分钟。',
      '取消时先用 list 取得调度 id，再用 cancel。',
      '短休息使用 pause；只有需要未来重新获得注意力时才创建 schedule。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'create') {
          const result = await runtime.create({
            name: args.name,
            intention: args.intention,
            schedule: args.schedule,
            ...(args.maxRuns === undefined ? {} : { maxRuns: args.maxRuns }),
          })
          return {
            content: JSON.stringify({
              ok: true,
              status: result.status,
              schedule: publicSchedule(result.schedule),
            }),
            outcome: { ok: true, code: result.status },
          }
        }

        if (args.action === 'list') {
          const schedules = await runtime.list()
          return {
            content: JSON.stringify({
              ok: true,
              schedules: schedules.map(publicSchedule),
            }),
            outcome: { ok: true, code: 'listed' },
          }
        }

        if (args.action === 'get_occurrence') {
          const occurrence = await runtime.getOccurrence(args.scheduleId, args.runCount)
          return {
            content: JSON.stringify(occurrence == null
              ? {
                  ok: false,
                  status: 'not_found',
                  scheduleId: args.scheduleId,
                  runCount: args.runCount,
                }
              : {
                  ok: true,
                  occurrence: {
                    ...occurrence,
                    scheduledFor: beijingTimestamp(occurrence.scheduledFor),
                  },
                  instruction: '这是注意信号，不是命令；结合最新 Goal、消息和环境重新评估，只在仍有意义时行动。',
                }),
            outcome: {
              ok: occurrence != null,
              code: occurrence == null ? 'not_found' : 'observed',
              progress: occurrence != null,
            },
          }
        }

        const result = await runtime.cancel(args.id)
        return {
          content: JSON.stringify({
            ok: true,
            status: result.status,
            id: result.id,
          }),
          outcome: { ok: true, code: result.status },
        }
      } catch (error) {
        if (!(error instanceof ScheduleRuntimeError)) throw error
        return runtimeErrorResult(error)
      }
    },
  }
}

function publicSchedule(job: ScheduleJob) {
  return {
    id: job.id,
    name: job.name,
    intention: job.intention,
    schedule: publicScheduleSpec(job.schedule),
    nextRunAt: beijingTimestamp(job.nextRunAt),
    expiresAt: beijingTimestamp(job.expiresAt),
    runCount: job.runCount,
    ...(job.maxRuns === undefined ? {} : { maxRuns: job.maxRuns }),
  }
}

function publicScheduleSpec(schedule: ScheduleSpec): ScheduleSpec {
  if (schedule.kind === 'at') {
    return { kind: 'at', at: beijingTimestamp(schedule.at) }
  }
  if (schedule.kind === 'every') {
    return {
      kind: 'every',
      everySeconds: schedule.everySeconds,
      anchorAt: beijingTimestamp(schedule.anchorAt),
    }
  }
  return {
    kind: 'cron',
    expression: schedule.expression,
    timezone: schedule.timezone,
  }
}

function beijingTimestamp(timestamp: string): string {
  return formatBeijingIso(new Date(timestamp))
}

function runtimeErrorResult(error: ScheduleRuntimeError): ToolExecutionResult {
  const message = runtimeErrorMessage(error.code)
  return {
    content: JSON.stringify({
      ok: false,
      status: error.code,
      error: message,
      ...(error.code === 'name_conflict' && error.scheduleId
        ? {
            id: error.scheduleId,
            cancel: { action: 'cancel', id: error.scheduleId },
          }
        : {}),
    }),
    outcome: { ok: false, code: error.code },
  }
}

function runtimeErrorMessage(code: ScheduleRuntimeError['code']): string {
  switch (code) {
    case 'name_conflict':
      return '同名活跃调度已存在；请先用返回的 id 调用 schedule cancel，再创建新定义。'
    case 'active_limit_reached':
      return '活跃调度已达到 20 个上限；请先 list 并 cancel 不再需要的调度。'
    case 'invalid_input':
      return '调度参数无效；请根据当前 schema 修正后重试。'
    case 'invalid_schedule':
      return '调度时间或表达式无效；请修正 schedule 后重试。'
    case 'recurrence_too_frequent':
      return '周期触发间隔必须至少 5 分钟；请降低触发频率。'
    case 'outside_schedule_window':
      return '调度在最长 3 天有效期内没有可触发时间；请调整时间。'
    case 'persistence_failed':
      return '调度状态暂时无法持久化，操作未确认成功；请稍后重试。'
    case 'timer_failed':
      return '调度定时器暂时不可用，操作未确认成功；请稍后重试。'
    case 'not_started':
      return '调度运行时尚未启动；请稍后重试。'
    case 'already_started':
      return '调度运行时正在启动；请稍后重试。'
    case 'stopped':
      return '调度运行时已停止；当前不能管理调度。'
  }
}
