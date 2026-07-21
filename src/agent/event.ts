/**
 * BotEvent: 进入 BotLoopAgent 主循环的所有外部刺激统一类型。
 *
 * MVP-2 多源单上下文:
 *  - napcat_message:         群消息 (含 groupName 用于 per-event 标签).
 *  - napcat_private_message: 私聊消息. mentionedSelf 恒为 true (私聊默认对 bot 说).
 *  - wake:                   "解阻塞"信号, stop() 用, 以及未来 timer wakeup 用.
 *  - bootstrap:              无持久 snapshot 且没有待处理事件时的首次启动信号.
 *  - curiosity_tick:         SIGUSR1 人工调试唤醒。正常自主节奏由 pause 自定休息和
 *                            BotLoop guard 管理，不依赖 tick。
 *
 * 所有 napcat_* 事件: renderedText 已在 ingest 时一次性冻结 (含媒体描述), 字节稳定.
 */
export type BotEvent =
  | {
      type: 'napcat_message'
      messageRowId: number
      groupId: number
      /** 群名: 优先用消息事件 payload 里的, 缺失时由 ingest 时 napcat.get_group_info 补齐. */
      groupName?: string
      messageId: number
      senderId: number
      senderNickname: string
      mentionedSelf: boolean
      sentAt: Date
      /** 已渲染好的纯文本内容(含 [图片: ...] 媒体描述), 字节稳定。 */
      renderedText: string
    }
  | {
      type: 'napcat_private_message'
      messageRowId: number
      /** 私聊对方 QQ. */
      peerId: number
      messageId: number
      /** = peerId, 留字段为了与 group 事件对齐. */
      senderId: number
      senderNickname: string
      /** 私聊一律视为对 bot 的呼叫 (常量, render 不必读). */
      mentionedSelf: true
      sentAt: Date
      /** 已渲染好的纯文本内容(含 [图片: ...] 媒体描述), 字节稳定。 */
      renderedText: string
    }
  | { type: 'wake' }
  | { type: 'bootstrap' }
  | { type: 'curiosity_tick' }
  | {
      type: 'scheduled_wake'
      scheduleId: string
      name: string
      scheduleKind: 'at' | 'every' | 'cron'
      scheduledFor: Date
      intention: string
      runCount: number
    }
  | {
      type: 'background_task_completed'
      taskId: string
      toolName: string
      description: string
      elapsedMs: number
      ok: boolean
      summary: string
    }
  | {
      type: 'mailbox_backlog'
      mailboxKey: string
      priority: 'high' | 'normal'
      source:
        | { type: 'group'; groupId: number; groupName: string | null }
        | { type: 'private'; peerId: number; senderName: string }
      count: number
      firstRowId: number
      throughRowId: number
      recentAfterRowId: number
      senderCount: number | null
      timeRange: { from: Date; to: Date }
    }

export type ChatMessageEvent = Extract<
  BotEvent,
  { type: 'napcat_message' | 'napcat_private_message' }
>

/** 只有私聊或群内结构化 @ 才有资格进入会打断主循环的注意事件队列。 */
export function isChatAttentionEvent(event: ChatMessageEvent): boolean {
  return event.type === 'napcat_private_message' || event.mentionedSelf
}

/**
 * 私聊/@ 始终入队；普通群消息只有在显式启用 passive notification 的群里入队。
 * passive 只决定下一次自然轮次能否看到 badge，不会因此成为 attention。
 */
export function shouldQueueChatEvent(
  event: ChatMessageEvent,
  passiveGroupIds: ReadonlySet<number>,
): boolean {
  return isChatAttentionEvent(event)
    || (event.type === 'napcat_message' && passiveGroupIds.has(event.groupId))
}
