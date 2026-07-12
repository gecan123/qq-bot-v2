import { z } from 'zod'
import type { DurableWakeScheduler } from '../durable-wake-scheduler.js'
import type { Tool } from '../tool.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    delaySeconds: z.number().int().min(30).max(7 * 24 * 60 * 60)
      .describe('从现在起多久后唤醒，30 秒到 7 天。'),
    reason: z.string().trim().min(1).max(300)
      .describe('届时醒来要处理的具体事情。'),
  }),
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('cancel'), scheduleId: z.string().min(1) }),
])

type Args = z.infer<typeof argsSchema>

export function createScheduleTool(scheduler: DurableWakeScheduler): Tool<Args> {
  return {
    name: 'schedule',
    description: [
      '管理可跨重启恢复的定时唤醒。',
      'create 在 30 秒到 7 天后注入 scheduled_wake 事件；list 查看未触发项；cancel 取消。',
      '短暂休息仍用 pause；需要明确的未来时间点再用本工具。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'create') {
        const wake = scheduler.schedule(args)
        return {
          content: JSON.stringify({
            ok: true,
            scheduleId: wake.id,
            dueAt: formatBeijingIso(wake.dueAt),
            reason: wake.reason,
          }),
          outcome: { ok: true, code: 'scheduled' },
        }
      }
      if (args.action === 'list') {
        return {
          content: JSON.stringify({
            ok: true,
            schedules: scheduler.list().map((wake) => ({
              scheduleId: wake.id,
              dueAt: formatBeijingIso(wake.dueAt),
              reason: wake.reason,
            })),
          }),
        }
      }
      const cancelled = scheduler.cancel(args.scheduleId)
      return {
        content: JSON.stringify({
          ok: cancelled,
          scheduleId: args.scheduleId,
          status: cancelled ? 'cancelled' : 'not_found_or_not_running',
        }),
        outcome: { ok: cancelled, code: cancelled ? 'cancelled' : 'not_found' },
      }
    },
  }
}
