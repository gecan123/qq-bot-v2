import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId, getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { getOrCreateConversationState } from '../conversation/conversation-state-store.js'
import { toSenderReplyScopeKey } from '../conversation/reply-scope.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId } from '../runtime/agent-runtime-types.js'
import type { ActionRecord } from '../runtime/agent-runtime-types.js'

export interface BuildContextResult {
  contextText: string
  recentMessages: Message[]
}

export interface ContextBuildOptions {
  mediaDeadlineAt?: number
  runtimeContextFallback?: 'runtime' | 'ledger'
}

interface ContextBuildDependencies {
  [key: string]: unknown
  getConversationState?: typeof getOrCreateConversationState
  getRecentMessages?: typeof getRecentGroupMessages
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getStoredMessage?: typeof getMessageById
  resolveStoredMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
  listActionRecords?: typeof listSentActionRecordsForScene
}

function getRemainingBudget(deadlineAt?: number): number {
  if (deadlineAt == null) return config.replyMediaTimeoutMs
  return Math.max(deadlineAt - Date.now(), 0)
}

async function getStableResolvedText(
  message: Message,
  options: ContextBuildOptions = {},
  dependencies: ContextBuildDependencies = {},
): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen

  const resolveStoredMessage = dependencies.resolveStoredMessage ?? resolveMessage
  const freezeResolvedText = dependencies.freezeResolvedText ?? freezeResolvedTextIfUnset
  const resolvedSegments = await resolveStoredMessage(message, { timeoutMs: getRemainingBudget(options.mediaDeadlineAt) })
  const resolvedText = segmentsToPlainText(resolvedSegments)
  await freezeResolvedText(message.id, resolvedText)
  return resolvedText
}

function actionRecordText(actionRecord: ActionRecord): string | null {
  if (actionRecord.deliveryState !== 'sent' && actionRecord.deliveryState !== 'acked') return null
  const payload = actionRecord.resultPayload
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  return text ? `[BOT] ${text}` : null
}

export async function buildContext(
  msg: IncomingMessage,
  contextLimit: number,
  options: ContextBuildOptions = {},
  dependencies: ContextBuildDependencies = {},
): Promise<BuildContextResult> {
  const lines: string[] = []
  const scopeKey = toSenderReplyScopeKey(msg.senderId)
  const getConversationState = dependencies.getConversationState ?? getOrCreateConversationState
  const getStoredMessage = dependencies.getStoredMessage ?? getMessageById
  const getRecentMessages = dependencies.getRecentMessages ?? getRecentGroupMessages
  const getMessagesAfterRowId = dependencies.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const listActionRecords = dependencies.listActionRecords ?? listSentActionRecordsForScene
  const conversationState = await getConversationState(msg.groupId, scopeKey)

  if (conversationState.compactedBase.trim()) {
    lines.push('[压缩上下文]')
    lines.push(conversationState.compactedBase.trim())
    lines.push('')
  }

  const quoted = msg.segments.find((segment): segment is ReplySegment => segment.type === 'reply')
  if (quoted) {
    const quotedMessage = await getStoredMessage(msg.groupId, Number(quoted.messageId))
    if (quotedMessage) {
      const nickname = quotedMessage.senderGroupNickname ?? quotedMessage.senderNickname
      const text = await getStableResolvedText(quotedMessage, options, dependencies)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
    }
  }

  const recentMessages = conversationState.lastCompactedMessageRowId
    ? await getMessagesAfterRowId(msg.groupId, conversationState.lastCompactedMessageRowId)
    : await getRecentMessages(msg.groupId, contextLimit)
  const renderedMessages: string[] = []
  for (const dbMsg of recentMessages.slice(-contextLimit)) {
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname ?? String(dbMsg.senderId)
    const text = await getStableResolvedText(dbMsg, options, dependencies)
    if (text.trim()) renderedMessages.push(`[QQ消息]\n${nickname}: ${text}`)
  }

  const actionRecords = await listActionRecords(makeQqGroupSceneId(msg.groupId))
  const renderedActions = actionRecords
    .filter((actionRecord) => !conversationState.lastCompactedMessageRowId || actionRecord.createdAt.getTime() > 0)
    .map(actionRecordText)
    .filter((text): text is string => Boolean(text))

  const windowText = [...renderedMessages, ...renderedActions].slice(-contextLimit).join('\n')
  if (windowText) lines.push(windowText)

  return { contextText: lines.join('\n'), recentMessages }
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segmentsToPlainText(segments.filter((s) => s.type !== 'reply'))
}

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
