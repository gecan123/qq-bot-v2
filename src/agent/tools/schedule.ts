import { z } from 'zod'
import { ScheduleRuntimeError, type ScheduleRuntime } from '../schedule-runtime.js'
import { SCHEDULE_LIMITS } from '../schedule-model.js'
import type { ScheduleJob } from '../schedule-store.js'
import type { Tool, ToolExecutionResult } from '../tool.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const createBase = {
  action: z.literal('create'),
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength)
    .describe('活跃调度的唯一名称；同名同定义返回 existing。'),
  intention: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIntentionLength)
    .describe('到期后结合最新上下文重新判断的注意事项，不是未来命令。'),
}

const createSchema = z.object({
  ...createBase,
  at: z.string().trim().min(1).max(100).optional()
    .describe('带显式时区的未来 ISO 时间；create 时与 afterSeconds 必须且只能提供一个。'),
  afterSeconds: z.number().int().min(30).max(3 * 24 * 60 * 60).optional()
    .describe('从现在起多久后唤醒，30..259200 秒；create 时与 at 必须且只能提供一个。'),
}).strict().superRefine((value, context) => {
  if ((value.at === undefined) === (value.afterSeconds === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['at'],
      message: 'create must provide exactly one of at or afterSeconds',
    })
  }
})

const argsSchema = z.union([
  createSchema,
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    action: z.literal('get_occurrence'),
    scheduleId: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxIdLength),
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
      '管理未来 30 秒到 3 天内的一次性注意力唤醒；create 只接受 at 或 afterSeconds。',
      '到期 notification 不携带 intention 正文；按通知给出的 scheduleId 调用 get_occurrence，再结合最新 Goal、消息和环境重新判断。',
      '取消时先 list 取得 id。当前无事可做时用 yield；不要用 schedule 等回复或机械轮询。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'create') {
          const result = await runtime.create({
            name: args.name,
            intention: args.intention,
            ...(args.at !== undefined ? { at: args.at } : { afterSeconds: args.afterSeconds! }),
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
            content: JSON.stringify({ ok: true, schedules: schedules.map(publicSchedule) }),
            outcome: { ok: true, code: 'listed' },
          }
        }
        if (args.action === 'get_occurrence') {
          const occurrence = await runtime.getOccurrence(args.scheduleId)
          return {
            content: JSON.stringify(occurrence == null
              ? { ok: false, status: 'not_found', scheduleId: args.scheduleId }
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
          content: JSON.stringify({ ok: true, status: result.status, id: result.id }),
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
    at: beijingTimestamp(job.at),
    createdAt: beijingTimestamp(job.createdAt),
  }
}

function beijingTimestamp(timestamp: string): string {
  return formatBeijingIso(new Date(timestamp))
}

function runtimeErrorResult(error: ScheduleRuntimeError): ToolExecutionResult {
  return {
    content: JSON.stringify({
      ok: false,
      status: error.code,
      error: runtimeErrorMessage(error.code),
      ...(error.code === 'name_conflict' && error.scheduleId
        ? { id: error.scheduleId, cancel: { action: 'cancel', id: error.scheduleId } }
        : {}),
    }),
    outcome: { ok: false, code: error.code },
  }
}

function runtimeErrorMessage(code: ScheduleRuntimeError['code']): string {
  switch (code) {
    case 'name_conflict':
      return '同名活跃调度已存在；请先用返回的 id 调用 schedule cancel。'
    case 'active_limit_reached':
      return '活跃调度已达到 20 个上限；请先 list 并 cancel 不再需要的调度。'
    case 'invalid_input':
      return '调度参数无效；请根据当前 schema 修正后重试。'
    case 'invalid_schedule':
      return '调度时间无效；at 必须带显式时区。'
    case 'outside_schedule_window':
      return '调度必须位于未来 30 秒到 3 天内。'
    case 'persistence_failed':
      return '调度状态暂时无法持久化，操作未确认成功。'
    case 'timer_failed':
      return '调度定时器暂时不可用，操作未确认成功。'
    case 'not_started':
      return '调度运行时尚未启动。'
    case 'already_started':
      return '调度运行时正在启动或已经启动。'
    case 'stopped':
      return '调度运行时已停止。'
  }
}
