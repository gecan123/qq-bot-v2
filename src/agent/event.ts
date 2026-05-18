/**
 * BotEvent: 进入 BotLoopAgent 主循环的所有外部刺激统一类型。
 *
 * MVP-2 多源单上下文:
 *  - napcat_message:         群消息 (含 groupName 用于 per-event 标签).
 *  - napcat_private_message: 私聊消息. mentionedSelf 恒为 true (私聊默认对 bot 说).
 *  - wake:                   "解阻塞"信号, stop() 用, 以及未来 timer wakeup 用.
 *  - curiosity_tick:         外部节奏脉冲 (SIGUSR1 / cron / launchd 戳进来), 例行问 LLM
 *                            要不要刷一下论坛. 跟群消息密度脱钩, 进程内不维护定时器,
 *                            节奏感交给外面 (`pnpm tick` 或 OS 调度).
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
  | { type: 'curiosity_tick' }
  | {
      type: 'background_task_completed'
      taskId: string
      toolName: string
      description: string
      elapsedMs: number
      ok: boolean
      summary: string
    }

