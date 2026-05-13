import type { BotEvent } from './event.js'

/**
 * 把 BotEvent 翻译成喂给 LLM 的 user-role 文本。
 *
 * 字节稳定 (CLAUDE.md 红线 5): 同样的 messageRowId + sentAt + renderedText 必须每次输出同样字节。
 * sentAt 是消息自身的固定时间戳, 不是"当前时间", 所以不破坏 prefix 稳定性。
 *
 * Source labels (per-event, byte-stable):
 *   群消息 (有群名):    [2026/5/11 14:30:22 群:阳光厨房 | 昵称(QQ:123) [@bot]] text
 *   群消息 (无群名):    [2026/5/11 14:30:22 群:111111 | 昵称(QQ:123)] text
 *   私聊:              [2026/5/11 14:30:22 私聊 | 昵称(QQ:456)] text
 *   好奇心 tick:        [好奇心 tick] ...
 *
 * 私聊不带 [@bot] tag —— 私聊默认就是对 bot 说话, 这条规则在 system prompt 里告诉 LLM.
 */
export const CURIOSITY_TICK_TEXT =
  '[好奇心 tick] 例行戳一下, 要不要去刷点外面的东西看看? 随你判断, 不想刷就 wait.'

function formatBeijingTime(date: Date): string {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

export function renderBotEvent(event: BotEvent): string | null {
  if (event.type === 'wake') return null

  if (event.type === 'curiosity_tick') return CURIOSITY_TICK_TEXT

  if (event.type === 'napcat_message') {
    const ts = formatBeijingTime(event.sentAt)
    const mentionTag = event.mentionedSelf ? ' [@bot]' : ''
    const groupLabel = event.groupName && event.groupName.length > 0
      ? event.groupName
      : String(event.groupId)
    return `[${ts} 群:${groupLabel} | ${event.senderNickname}(QQ:${event.senderId})${mentionTag}] ${event.renderedText}`
  }

  if (event.type === 'napcat_private_message') {
    const ts = formatBeijingTime(event.sentAt)
    return `[${ts} 私聊 | ${event.senderNickname}(QQ:${event.senderId})] ${event.renderedText}`
  }

  return null
}
