import type { BotEvent } from './event.js'

/**
 * 把 BotEvent 翻译成喂给 LLM 的 user-role 文本。
 *
 * 字节稳定 (CLAUDE.md 红线 5): 同样的 messageRowId + renderedText 必须每次输出同样字节,
 * 不允许嵌时间戳 / 当前时间 / 相对时间。这里只是格式化,不读 DB,纯函数。
 */
export function renderBotEvent(event: BotEvent): string | null {
  if (event.type !== 'napcat_message') return null

  const mentionTag = event.mentionedSelf ? ' [@bot]' : ''
  return `[${event.senderNickname}(QQ:${event.senderId})${mentionTag}] ${event.renderedText}`
}
