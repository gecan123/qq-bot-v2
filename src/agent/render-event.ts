import type { BotEvent } from './event.js'

/**
 * 把 BotEvent 翻译成喂给 LLM 的 user-role 文本。
 *
 * 字节稳定 (AGENTS.md / CLAUDE.md 红线 5): 同样的 messageRowId + sentAt + renderedText 必须每次输出同样字节。
 * sentAt 是消息自身的固定时间戳, 不是"当前时间", 所以不破坏 prefix 稳定性。
 * `#NNNNN` 是 napcat 的 message_id, BotEvent 自带, 同源同条永远同一个数, 不破坏 cache 前缀。
 *
 * Source labels (per-event, byte-stable):
 *   群消息 (有群名):    [2026/5/11 14:30:22 群:阳光厨房 | 昵称(QQ:123) #12345 [@bot]] text
 *   群消息 (无群名):    [2026/5/11 14:30:22 群:111111 | 昵称(QQ:123) #12345] text
 *   私聊:              [2026/5/11 14:30:22 私聊 | 昵称(QQ:456) #50000] text
 *   冷启动:            [冷启动] ...
 *   好奇心 tick:        [好奇心 tick] ...
 *
 * 私聊不带 [@bot] tag —— 私聊默认就是对 bot 说话, 这条规则在 system prompt 里告诉 LLM.
 * `#NNNNN` 紧跟在 (QQ:N) 之后, 是这条消息的 message_id —— LLM 想 reply 时把这个数填进
 * send_message 的 replyToMessageId. 不暴露这个数, LLM 就只能瞎猜出一个临近的 id.
 */
export const CURIOSITY_TICK_TEXT =
  '[好奇心 tick] 这是一次人工调试唤醒, 不是你好奇心的来源. 按自己当前的兴趣、todo 和 intention 决定下一步.'

export const BOOTSTRAP_TEXT =
  '[冷启动] 这是一次全新 AgentContext 的首次启动, 当前没有待回复的历史消息. 按自己的身份、兴趣、todo 和 intention 决定第一步.'

function formatBeijingTime(date: Date): string {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

export function renderBotEvent(event: BotEvent): string | null {
  if (event.type === 'wake') return null

  if (event.type === 'bootstrap') return BOOTSTRAP_TEXT

  if (event.type === 'curiosity_tick') return CURIOSITY_TICK_TEXT

  if (event.type === 'napcat_message') {
    const ts = formatBeijingTime(event.sentAt)
    const mentionTag = event.mentionedSelf ? ' [@bot]' : ''
    const groupLabel = event.groupName && event.groupName.length > 0
      ? event.groupName
      : String(event.groupId)
    return `[${ts} 群:${groupLabel} | ${event.senderNickname}(QQ:${event.senderId}) #${event.messageId}${mentionTag}] ${event.renderedText}`
  }

  if (event.type === 'napcat_private_message') {
    const ts = formatBeijingTime(event.sentAt)
    return `[${ts} 私聊 | ${event.senderNickname}(QQ:${event.senderId}) #${event.messageId}] ${event.renderedText}`
  }

  if (event.type === 'background_task_completed') {
    return JSON.stringify({
      event: 'background_task_completed',
      taskId: event.taskId,
      toolName: event.toolName,
      ok: event.ok,
      elapsedMs: event.elapsedMs,
      description: event.description,
      summary: event.summary,
    })
  }

  return null
}
