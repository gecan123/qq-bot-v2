import { runProactiveGroupSession } from '../responder/proactive-session.js'
import type { ProactiveSendActionExecutor } from './proactive-send-dispatcher.js'
import { createLogger } from '../logger.js'

const log = createLogger('PROACTIVE_SCHEDULER')

export interface ProactiveSchedulerOptions {
  groupIds: number[]
  intervalMs: number
  /** 启动后多久跑第一次。默认 30s,避免和其它启动流程抢资源。 */
  initialDelayMs?: number
  /** 由调用方决定本次唤醒附带的论坛/外部摘要。null 表示没有外部输入。 */
  getForumDigest: () => string | null
  /** Phase 0: proactive_send 必须经过 ActionIntent + Barrier 链, 由调用方注入 actionExecutor。 */
  actionExecutor: ProactiveSendActionExecutor
  now?: () => Date
}

export function startProactiveScheduler(options: ProactiveSchedulerOptions): NodeJS.Timeout[] {
  if (options.intervalMs <= 0 || options.groupIds.length === 0) return []

  const now = options.now ?? (() => new Date())
  const initialDelayMs = options.initialDelayMs ?? 30_000

  const runOnce = async () => {
    const triggeredAt = now()
    const digest = options.getForumDigest()
    for (const groupId of options.groupIds) {
      try {
        await runProactiveGroupSession({
          groupId,
          forumDigest: digest,
          triggeredAt,
          actionExecutor: options.actionExecutor,
        })
      } catch (err) {
        log.warn({ err, groupId }, 'proactive group session crashed')
      }
    }
  }

  const timers: NodeJS.Timeout[] = []
  timers.push(setTimeout(() => void runOnce(), initialDelayMs))
  timers.push(setInterval(() => void runOnce(), options.intervalMs))
  return timers
}
