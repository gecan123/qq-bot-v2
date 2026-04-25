import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId } from '../database/messages.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId, type ActionRecord } from '../runtime/agent-runtime-types.js'
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
  getActionRecordsForScene?: typeof listSentActionRecordsForScene
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

function getActionRecordAnchor(actionRecord: ActionRecord): number | null {
  const payload = actionRecord.resultPayload
  const anchor = payload?.incorporatedMessageRowId ?? payload?.messageRowId
  return typeof anchor === 'number' && Number.isSafeInteger(anchor) ? anchor : null
}

function getActionRecordText(actionRecord: ActionRecord): string | null {
  const text = typeof actionRecord.resultPayload?.text === 'string'
    ? actionRecord.resultPayload.text.trim()
    : ''
  return text || null
}

async function mergeLines(
  messages: Message[],
  actionRecords: ActionRecord[],
  dependencies: CompactionDependencies,
): Promise<Array<{ anchor: number; text: string }>> {
  const lines: Array<{ anchor: number; text: string }> = []
  const sortedActionRecords = [...actionRecords].sort((a, b) => {
    const left = getActionRecordAnchor(a) ?? Number.MAX_SAFE_INTEGER
    const right = getActionRecordAnchor(b) ?? Number.MAX_SAFE_INTEGER
    return left - right || a.createdAt.getTime() - b.createdAt.getTime()
  })
  let actionIndex = 0

  for (const message of messages) {
    const text = await getStableCompactionText(message, dependencies)
    const nickname = message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId)
    if (text) {
      lines.push({
        anchor: message.id,
        text: `[${formatTime(getMessageTimestamp(message))}] ${nickname}: ${text}`,
      })
    }

    while (actionIndex < sortedActionRecords.length) {
      const record = sortedActionRecords[actionIndex]
      const anchor = record ? getActionRecordAnchor(record) : null
      if (!record || anchor == null || anchor > message.id) break
      const actionText = getActionRecordText(record)
      if (actionText) {
        lines.push({
          anchor,
          text: `[${formatTime(record.createdAt)}] BOT: ${actionText}`,
        })
      }
      actionIndex++
    }
  }

  while (actionIndex < sortedActionRecords.length) {
    const record = sortedActionRecords[actionIndex]
    const anchor = record ? getActionRecordAnchor(record) : null
    const actionText = record ? getActionRecordText(record) : null
    if (record && anchor != null && actionText) {
      lines.push({
        anchor,
        text: `[${formatTime(record.createdAt)}] BOT: ${actionText}`,
      })
    }
    actionIndex++
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
  const getActionRecordsForScene = dependencies.getActionRecordsForScene ?? listSentActionRecordsForScene
  const saveCompactedState = dependencies.saveCompactedState ?? compactConversationState

  const state = await getConversationState(groupId, senderThreadKey)
  const lastCompactedMessageRowId = state.lastCompactedMessageRowId ?? 0
  const messages = await getMessagesAfterRowId(groupId, lastCompactedMessageRowId)
  if (messages.length <= COMPACTION_TRIGGER_USER_MESSAGES) return

  const boundaryMessage = messages[messages.length - COMPACTION_KEEP_RECENT_USER_MESSAGES - 1]
  if (!boundaryMessage) return

  const actionRecords = await getActionRecordsForScene(makeQqGroupSceneId(groupId))
  const compactedMessages = messages.filter((message) => message.id <= boundaryMessage.id)
  const compactedActionRecords = actionRecords.filter(
    (record) => {
      const anchor = getActionRecordAnchor(record)
      return anchor != null && anchor > lastCompactedMessageRowId && anchor <= boundaryMessage.id
    },
  )
  const lines = await mergeLines(compactedMessages, compactedActionRecords, dependencies)
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
