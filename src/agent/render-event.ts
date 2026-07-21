import type { BotEvent } from './event.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import { renderNotificationEnvelope } from './notification.js'
import { mailboxKeyForEvent, renderMailboxNotification } from './mailbox.js'

/**
 * 把 BotEvent 翻译成喂给 LLM 的 user-role 文本。
 *
 * 异步来源统一渲染成字节稳定、无正文的 notification envelope。消息正文只由 inbox，
 * 后台结果只由 background_task，schedule intention 只由 schedule.get_occurrence 按需读取。
 * wake 只是内部解阻塞信号；bootstrap/curiosity_tick 仍是显式控制事件，不伪装成通知。
 */
export const CURIOSITY_TICK_TEXT =
  '[好奇心 tick] 这是一次人工调试唤醒, 不是你好奇心的来源. 按自己当前的兴趣、todo 和 intention 决定下一步.'

export const BOOTSTRAP_TEXT =
  '[冷启动] 这是一次全新 AgentContext 的首次启动, 当前没有待回复的历史消息. 按自己的身份、兴趣、todo 和 intention 决定第一步.'

export function renderBotEvent(event: BotEvent): string | null {
  if (event.type === 'wake') return null

  if (event.type === 'bootstrap') return BOOTSTRAP_TEXT

  if (event.type === 'curiosity_tick') return CURIOSITY_TICK_TEXT

  if (event.type === 'scheduled_wake') {
    const scheduledFor = formatBeijingIso(event.scheduledFor)
    return renderNotificationEnvelope({
      id: `schedule:${event.scheduleId}:${event.runCount}`,
      source: { type: 'schedule', scheduleId: event.scheduleId },
      kind: 'schedule_due',
      priority: 'normal',
      delivery: 'interrupt',
      groupKey: `schedule:${event.scheduleId}`,
      count: 1,
      occurredAt: scheduledFor,
      open: {
        tool: 'schedule',
        args: {
          action: 'get_occurrence',
          scheduleId: event.scheduleId,
          runCount: event.runCount,
        },
      },
      data: {
        name: event.name,
        scheduleKind: event.scheduleKind,
        scheduledFor,
        runCount: event.runCount,
      },
    })
  }

  if (event.type === 'napcat_message') {
    return renderMailboxNotification(mailboxKeyForEvent(event)!, [event])
  }

  if (event.type === 'napcat_private_message') {
    return renderMailboxNotification(mailboxKeyForEvent(event)!, [event])
  }

  if (event.type === 'background_task_completed') {
    const status = event.ok ? 'completed' : 'failed'
    return renderNotificationEnvelope({
      id: `background_task:${event.taskId}:${status}`,
      source: {
        type: 'background_task',
        taskId: event.taskId,
        toolName: event.toolName,
      },
      kind: 'background_task_completed',
      priority: event.ok ? 'normal' : 'high',
      delivery: 'interrupt',
      groupKey: `background_task:${event.taskId}`,
      count: 1,
      open: {
        tool: 'background_task',
        args: { action: 'get', taskId: event.taskId },
      },
      data: {
        status,
        elapsedMs: event.elapsedMs,
      },
    })
  }

  return null
}
