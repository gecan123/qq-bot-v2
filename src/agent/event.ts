/**
 * BotEvent: 进入 BotLoopAgent 主循环的所有外部刺激统一类型。
 *
 * MVP 单群单上下文阶段只有两种:
 *  - napcat_message: 真实群消息已入库且媒体描述就绪, 等着 LLM 在下一轮读到。
 *    renderedText 已在 ingest 时一次性冻结(包含媒体描述), 字节稳定。
 *  - wake:           "解阻塞"信号,stop() 用,以及未来 timer wakeup 用。
 */
export type BotEvent =
  | {
      type: 'napcat_message'
      messageRowId: number
      groupId: number
      messageId: number
      senderId: number
      senderNickname: string
      mentionedSelf: boolean
      sentAt: Date
      /** 已渲染好的纯文本内容(含 [图片: ...] 媒体描述), 字节稳定。 */
      renderedText: string
    }
  | { type: 'wake' }

