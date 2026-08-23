import type { AgentGoal } from './goal-store.js'
import type { AgentActivityTrigger } from './activity-surface.js'
import type { BotEvent } from './event.js'

export function describeActivityTrigger(
  events: readonly BotEvent[],
  goal: AgentGoal | null,
): AgentActivityTrigger | null {
  for (const event of events) {
    if (event.type === 'chat_message') {
      const target = { ...event.conversation }
      if (event.conversation.kind === 'private') {
        return {
          kind: 'private_message',
          label: `收到 ${event.senderName || event.senderExternalId} 的私聊`,
          target,
        }
      }
      if (event.mentionedSelf || event.eventKind !== 'message') {
        return {
          kind: 'group_mention',
          label: event.mentionedSelf
            ? `${event.conversationName || event.conversation.externalId} 中有人提到了 Agent`
            : `${event.conversationName || event.conversation.externalId} 有消息${event.eventKind === 'edit' ? '编辑' : '撤回'}`,
          target,
        }
      }
      continue
    }
    if (event.type === 'napcat_private_message') {
      return {
        kind: 'private_message',
        label: `收到 ${event.senderNickname || event.peerId} 的私聊`,
        target: null,
      }
    }
    if (event.type === 'napcat_message' && event.mentionedSelf) {
      return {
        kind: 'group_mention',
        label: `群 ${event.groupName || event.groupId} 中有人提到了 Agent`,
        target: null,
      }
    }
    if (event.type === 'scheduled_wake') {
      return {
        kind: 'scheduled_wake',
        label: `计划“${event.name}”已到期`.slice(0, 500),
        target: null,
      }
    }
    if (event.type === 'background_task_completed') {
      return {
        kind: 'background_task',
        label: `后台任务 ${event.toolName} 已${event.ok ? '完成' : '失败'}：${event.description}`.slice(0, 500),
        target: null,
      }
    }
    if (event.type === 'mailbox_backlog') {
      if (event.source.type === 'conversation') {
        return {
          kind: event.source.conversation.kind === 'group' ? 'group_mention' : 'private_message',
          label: `恢复了 ${event.source.name || event.source.conversation.externalId} 的 ${event.count} 条待处理通知`,
          target: { ...event.source.conversation },
        }
      }
      return event.source.type === 'group'
        ? {
            kind: 'group_mention',
            label: `恢复了群 ${event.source.groupName || event.source.groupId} 的 ${event.count} 条待处理通知`,
            target: null,
          }
        : {
            kind: 'private_message',
            label: `恢复了 ${event.source.senderName} 的 ${event.count} 条待处理私聊`,
            target: null,
          }
    }
    if (event.type === 'bootstrap') {
      return { kind: 'bootstrap', label: '首次启动，开始建立自己的初始方向', target: null }
    }
    if (event.type === 'wake') {
      return { kind: 'manual_wake', label: '收到运行时唤醒信号', target: null }
    }
  }
  if (goal?.status === 'active') {
    return { kind: 'goal', label: `继续推进 Goal：${goal.objective}`.slice(0, 500), target: null }
  }
  return null
}
