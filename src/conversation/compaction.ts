import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId } from '../database/messages.js'
import { listSentReplyRecordsAfterMessageRowId, type ReplyRecord } from './reply-record-store.js'
import { compactConversationState, getOrCreateConversationState } from './conversation-state-store.js'
import { resolveMessage } from '../media/message-resolver.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { getMessageTimestamp } from '../utils/message-time.js'
import type { Message } from '../generated/prisma/client.js'

const COMPACTION_TRIGGER_USER_MESSAGES = 40
const COMPACTION_KEEP_RECENT_USER_MESSAGES = 12

interface CompactionDependencies {
  getConversationState?: typeof getOrCreateConversationState
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getReplyRecordsAfterRowId?: typeof listSentReplyRecordsAfterMessageRowId
  resolveConversationMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
  saveCompactedState?: typeof compactConversationState
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

async function getStableCompactionText(message: Message, dependencies: CompactionDependencies): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen

  const resolveConversationMessage = dependencies.resolveConversationMessage ?? resolveMessage
  const freezeResolvedText = dependencies.freezeResolvedText ?? freezeResolvedTextIfUnset
  const resolvedSegments = await resolveConversationMessage(message, { timeoutMs: 0 })
  const resolvedText = segmentsToPlainText(resolvedSegments).trim()
  await freezeResolvedText(message.id, resolvedText)
  return resolvedText
}

async function mergeLines(
  messages: Message[],
  replyRecords: ReplyRecord[],
  dependencies: CompactionDependencies,
): Promise<Array<{ anchor: number; text: string }>> {
  const lines: Array<{ anchor: number; text: string }> = []
  let replyIndex = 0

  for (const message of messages) {
    const text = await getStableCompactionText(message, dependencies)
    const nickname = message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId)
    if (text) {
      lines.push({
        anchor: message.id,
        text: `[${formatTime(getMessageTimestamp(message))}] ${nickname}: ${text}`,
      })
    }

    while (replyIndex < replyRecords.length) {
      const record = replyRecords[replyIndex]
      if (!record || (record.incorporatedMessageRowId ?? Number.MAX_SAFE_INTEGER) > message.id) break
      lines.push({
        anchor: record.incorporatedMessageRowId ?? message.id,
        text: `[${formatTime(record.createdAt)}] BOT: ${record.text}`,
      })
      replyIndex++
    }
  }

  return lines
}

export async function compactConversationIfNeeded(
  groupId: number,
  senderThreadKey: string,
  dependencies: CompactionDependencies = {},
): Promise<void> {
  const getConversationState = dependencies.getConversationState ?? getOrCreateConversationState
  const getMessagesAfterRowId = dependencies.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const getReplyRecordsAfterRowId = dependencies.getReplyRecordsAfterRowId ?? listSentReplyRecordsAfterMessageRowId
  const saveCompactedState = dependencies.saveCompactedState ?? compactConversationState

  const state = await getConversationState(groupId, senderThreadKey)
  const messages = await getMessagesAfterRowId(groupId, state.lastCompactedMessageRowId)
  if (messages.length <= COMPACTION_TRIGGER_USER_MESSAGES) return

  const boundaryMessage = messages[messages.length - COMPACTION_KEEP_RECENT_USER_MESSAGES - 1]
  if (!boundaryMessage) return

  const replyRecords = await getReplyRecordsAfterRowId(
    groupId,
    senderThreadKey,
    state.lastCompactedMessageRowId,
  )
  const compactedMessages = messages.filter((message) => message.id <= boundaryMessage.id)
  const compactedReplyRecords = replyRecords.filter(
    (record) => (record.incorporatedMessageRowId ?? Number.MAX_SAFE_INTEGER) <= boundaryMessage.id,
  )
  const lines = await mergeLines(compactedMessages, compactedReplyRecords, dependencies)
  if (lines.length === 0) return

  const nextBase = [state.compactedBase.trim(), lines.map((line) => line.text).join('\n')]
    .filter((part) => part.length > 0)
    .join('\n')

  await saveCompactedState({
    groupId,
    senderThreadKey,
    compactedBase: nextBase,
    lastCompactedMessageRowId: boundaryMessage.id,
  })
}
