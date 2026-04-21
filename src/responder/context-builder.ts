import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId, getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { listSentAssistantTurns, listSentAssistantTurnsAfterMessageRowId } from '../conversation/assistant-turn-store.js'
import { getOrCreateConversationState } from '../conversation/conversation-state-store.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { getMessageTimestamp } from '../utils/message-time.js'

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export interface BuildContextResult {
  contextText: string
  recentMessages: Message[]
}

export interface ContextBuildOptions {
  mediaDeadlineAt?: number
}

function getRemainingBudget(deadlineAt?: number): number {
  if (deadlineAt == null) return config.replyMediaTimeoutMs
  return Math.max(deadlineAt - Date.now(), 0)
}

async function getStableResolvedText(message: Message, options: ContextBuildOptions = {}): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen

  const resolvedSegments = await resolveMessage(message, { timeoutMs: getRemainingBudget(options.mediaDeadlineAt) })
  const resolvedText = segmentsToPlainText(resolvedSegments)
  await freezeResolvedTextIfUnset(message.id, resolvedText)
  return resolvedText
}

export async function buildContext(
  msg: IncomingMessage,
  contextLimit: number,
  options: ContextBuildOptions = {},
): Promise<BuildContextResult> {
  const lines: string[] = []
  const senderThreadKey = toSenderThreadKey(msg.senderId)
  const conversationState = await getOrCreateConversationState(msg.groupId, senderThreadKey)

  if (conversationState.compactedBase.trim()) {
    lines.push('[压缩上下文]')
    lines.push(conversationState.compactedBase.trim())
    lines.push('')
  }

  const replySegment = msg.segments.find((s): s is ReplySegment => s.type === 'reply')
  if (replySegment) {
    const replyMsgId = Number(replySegment.messageId)
    const quotedMsg = await getMessageById(msg.groupId, replyMsgId)
    if (quotedMsg) {
      const nickname = quotedMsg.senderGroupNickname ?? quotedMsg.senderNickname
      const text = await getStableResolvedText(quotedMsg, options)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
    }
  }

  const recentMessages = conversationState.lastCompactedMessageRowId
    ? await getGroupMessagesAfterRowId(msg.groupId, conversationState.lastCompactedMessageRowId)
    : await getRecentGroupMessages(msg.groupId, contextLimit)
  const assistantTurns = conversationState.lastCompactedMessageRowId
    ? await listSentAssistantTurnsAfterMessageRowId(msg.groupId, senderThreadKey, conversationState.lastCompactedMessageRowId)
    : await listSentAssistantTurns(msg.groupId, senderThreadKey)
  const resolvedRecentTexts: string[] = []
  for (const dbMsg of recentMessages) {
    resolvedRecentTexts.push(await getStableResolvedText(dbMsg, options))
  }
  let assistantIndex = 0

  for (const [index, dbMsg] of recentMessages.entries()) {
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname
    const time = formatTime(getMessageTimestamp(dbMsg))
    const text = resolvedRecentTexts[index] ?? ''
    if (text) lines.push(`[${time}] ${nickname}: ${text}`)

    while (assistantIndex < assistantTurns.length) {
      const turn = assistantTurns[assistantIndex]
      if (!turn || turn.incorporatedMessageRowId > dbMsg.id) break
      lines.push(`[${formatTime(turn.createdAt)}] BOT: ${turn.text}`)
      assistantIndex++
    }
  }

  while (assistantIndex < assistantTurns.length) {
    const turn = assistantTurns[assistantIndex]
    if (!turn) break
    lines.push(`[${formatTime(turn.createdAt)}] BOT: ${turn.text}`)
    assistantIndex++
  }

  return { contextText: lines.join('\n'), recentMessages }
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segmentsToPlainText(segments.filter((s) => s.type !== 'reply'))
}

/**
 * 从数据库中解析当前消息并提取 trigger 文本，包含图片描述等媒体信息。
 * 在 buildContext 之后调用，此时 ensureDescriptions 已完成。
 */
export async function extractResolvedTriggerText(
  groupId: number,
  messageId: number,
  fallbackSegments: ParsedSegment[],
  options: ContextBuildOptions = {},
): Promise<string> {
  const dbMsg = await getMessageById(groupId, messageId)
  if (!dbMsg) return extractTriggerText(fallbackSegments)
  return getStableResolvedText(dbMsg, options)
}
