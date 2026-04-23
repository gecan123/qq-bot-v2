import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId, getRecentGroupMessages, getMessageById } from '../database/messages.js'
import {
  getLatestSentReplyRecord,
  listSentReplyRecords,
  listSentReplyRecordsAfterMessageRowId,
} from '../conversation/reply-record-store.js'
import { getOrCreateConversationState } from '../conversation/conversation-state-store.js'
import { parseSenderReplyScopeKey, toSenderReplyScopeKey } from '../conversation/reply-scope.js'
import { getRootRuntimeSnapshotByRuntimeKey } from '../runtime/snapshot-store.js'
import { getGroupRuntimeKey } from '../runtime/root-runtime.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { RuntimeContextMessage } from '../runtime/types.js'

export interface BuildContextResult {
  contextText: string
  recentMessages: Message[]
}

export interface ContextBuildOptions {
  mediaDeadlineAt?: number
}

interface ContextBuildDependencies {
  getConversationState?: typeof getOrCreateConversationState
  getRuntimeSnapshot?: typeof getRootRuntimeSnapshotByRuntimeKey
  getRecentMessages?: typeof getRecentGroupMessages
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getLatestSentTurn?: typeof getLatestSentReplyRecord
  listReplyRecords?: typeof listSentReplyRecords
  listReplyRecordsAfterRowId?: typeof listSentReplyRecordsAfterMessageRowId
  getStoredMessage?: typeof getMessageById
  resolveStoredMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
}

function formatRuntimeGroupMessageContent(nickname: string, text: string): string {
  return `[QQ消息]\n${nickname}: ${text}`
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

function renderRuntimeContextMessages(messages: RuntimeContextMessage[]): string {
  const lines = [...messages]
    .sort((left, right) => {
      if (left.orderKey !== right.orderKey) {
        return left.orderKey - right.orderKey
      }

      if (left.kind !== right.kind) {
        return left.kind === 'group_message' ? -1 : 1
      }

      if (left.senderId !== right.senderId) {
        return left.senderId - right.senderId
      }

      return left.content.localeCompare(right.content)
    })
    .flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'model') {
      return []
    }

    const content = message.content.trim()
    if (!content) {
      return []
    }

    if (message.role === 'model') {
      return [`[BOT] ${content}`]
    }

    return [content]
    })

  return lines.join('\n')
}

function filterRuntimeContextMessagesForPrompt(
  messages: RuntimeContextMessage[],
  options: { lastCompactedMessageRowId?: number; senderId: number },
): RuntimeContextMessage[] {
  return messages.filter((message) => {
    if (options.lastCompactedMessageRowId != null && message.orderKey <= options.lastCompactedMessageRowId) {
      return false
    }

    if (message.kind === 'assistant_turn' && message.senderId !== options.senderId) {
      return false
    }

    return true
  })
}

function selectRuntimeContextWindow(
  messages: RuntimeContextMessage[],
  contextLimit: number,
): RuntimeContextMessage[] {
  if (contextLimit <= 0) {
    return []
  }

  const sortedMessages = [...messages].sort((left, right) => {
    if (left.orderKey !== right.orderKey) {
      return left.orderKey - right.orderKey
    }

    if (left.kind !== right.kind) {
      return left.kind === 'group_message' ? -1 : 1
    }

    if (left.senderId !== right.senderId) {
      return left.senderId - right.senderId
    }

    return left.content.localeCompare(right.content)
  })
  const groupMessages = sortedMessages.filter((message) => message.kind === 'group_message')
  if (groupMessages.length <= contextLimit) {
    return sortedMessages
  }

  const firstIncludedGroupMessage = groupMessages[groupMessages.length - contextLimit]
  if (!firstIncludedGroupMessage) {
    return sortedMessages
  }

  return sortedMessages.filter((message) => message.orderKey >= firstIncludedGroupMessage.orderKey)
}

async function shouldUseRuntimeSnapshotContext(input: {
  groupId: number
  messageId: number
  scopeKey: string
  getStoredMessage: typeof getMessageById
  getRuntimeSnapshot: typeof getRootRuntimeSnapshotByRuntimeKey
  getLatestSentTurn: typeof getLatestSentReplyRecord
}): Promise<boolean> {
  const runtimeSnapshot = await input.getRuntimeSnapshot(getGroupRuntimeKey(input.groupId))
  if (!runtimeSnapshot || runtimeSnapshot.contextSnapshot.messages.length === 0) {
    return false
  }

  const currentMessage = await input.getStoredMessage(input.groupId, input.messageId)
  if (!currentMessage) {
    return false
  }

  const observedEnough = (runtimeSnapshot.lastObservedMessageRowId ?? 0) >= currentMessage.id
  if (!observedEnough) {
    return false
  }

  const latestSentTurn = await input.getLatestSentTurn(input.groupId, input.scopeKey)
  if (!latestSentTurn) {
    return true
  }

  const senderContinuity = runtimeSnapshot.sessionSnapshot.senderContinuities.find(
    (continuity) => continuity.senderThreadKey === input.scopeKey,
  )
  return (senderContinuity?.lastMaterializedMessageRowId ?? 0) >= (latestSentTurn.incorporatedMessageRowId ?? 0)
}

async function buildRuntimeContextFromLedgers(input: {
  groupId: number
  scopeKey: string
  contextLimit: number
  lastCompactedMessageRowId?: number
  getRecentMessages: typeof getRecentGroupMessages
  getMessagesAfterRowId: typeof getGroupMessagesAfterRowId
  listReplyRecords: typeof listSentReplyRecords
  listReplyRecordsAfterRowId: typeof listSentReplyRecordsAfterMessageRowId
  resolveText: (message: Message) => Promise<string>
}): Promise<Pick<BuildContextResult, 'recentMessages'> & { runtimeMessages: RuntimeContextMessage[] }> {
  const recentMessages = input.lastCompactedMessageRowId
    ? await input.getMessagesAfterRowId(input.groupId, input.lastCompactedMessageRowId)
    : await input.getRecentMessages(input.groupId, input.contextLimit)
  const replyRecords = input.lastCompactedMessageRowId
    ? await input.listReplyRecordsAfterRowId(input.groupId, input.scopeKey, input.lastCompactedMessageRowId)
    : await input.listReplyRecords(input.groupId, input.scopeKey)
  const resolvedRecentTexts: string[] = []
  for (const dbMsg of recentMessages) {
    resolvedRecentTexts.push(await input.resolveText(dbMsg))
  }

  const runtimeMessages: RuntimeContextMessage[] = []
  let replyIndex = 0
  const scopeSenderId = parseSenderReplyScopeKey(input.scopeKey)

  for (const [index, dbMsg] of recentMessages.entries()) {
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname ?? String(dbMsg.senderId)
    const text = resolvedRecentTexts[index] ?? ''
    if (text) {
      runtimeMessages.push({
        role: 'user',
        kind: 'group_message',
        orderKey: dbMsg.id,
        senderId: Number(dbMsg.senderId),
        content: formatRuntimeGroupMessageContent(nickname, text),
      })
    }

    while (replyIndex < replyRecords.length) {
      const record = replyRecords[replyIndex]
      if (!record || (record.incorporatedMessageRowId ?? Number.MAX_SAFE_INTEGER) > dbMsg.id) break
      runtimeMessages.push({
        role: 'model',
        kind: 'assistant_turn',
        orderKey: record.incorporatedMessageRowId ?? dbMsg.id,
        senderId: scopeSenderId ?? Number(dbMsg.senderId),
        content: record.text,
      })
      replyIndex++
    }
  }

  while (replyIndex < replyRecords.length) {
    const record = replyRecords[replyIndex]
    if (!record) break
    runtimeMessages.push({
      role: 'model',
      kind: 'assistant_turn',
      orderKey: record.incorporatedMessageRowId ?? recentMessages[recentMessages.length - 1]?.id ?? 0,
      senderId: scopeSenderId ?? Number(recentMessages[recentMessages.length - 1]?.senderId ?? 0),
      content: record.text,
    })
    replyIndex++
  }

  return { runtimeMessages, recentMessages }
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
  const getRuntimeSnapshot = dependencies.getRuntimeSnapshot ?? getRootRuntimeSnapshotByRuntimeKey
  const getStoredMessage = dependencies.getStoredMessage ?? getMessageById
  const getRecentMessages = dependencies.getRecentMessages ?? getRecentGroupMessages
  const getMessagesAfterRowId = dependencies.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const getLatestSentTurn = dependencies.getLatestSentTurn ?? getLatestSentReplyRecord
  const listReplyRecords = dependencies.listReplyRecords ?? listSentReplyRecords
  const listReplyRecordsAfterRowId = dependencies.listReplyRecordsAfterRowId ?? listSentReplyRecordsAfterMessageRowId
  const conversationState = await getConversationState(msg.groupId, scopeKey)

  if (conversationState.compactedBase.trim()) {
    lines.push('[压缩上下文]')
    lines.push(conversationState.compactedBase.trim())
    lines.push('')
  }

  const replySegment = msg.segments.find((s): s is ReplySegment => s.type === 'reply')
  if (replySegment) {
    const replyMsgId = Number(replySegment.messageId)
    const quotedMsg = await getStoredMessage(msg.groupId, replyMsgId)
    if (quotedMsg) {
      const nickname = quotedMsg.senderGroupNickname ?? quotedMsg.senderNickname
      const text = await getStableResolvedText(quotedMsg, options, dependencies)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
    }
  }

  const shouldUseSnapshot = await shouldUseRuntimeSnapshotContext({
    groupId: msg.groupId,
    messageId: msg.messageId,
    scopeKey,
    getStoredMessage,
    getRuntimeSnapshot,
    getLatestSentTurn,
  })
  const renderRuntimeContextText = (messages: RuntimeContextMessage[]): string =>
    renderRuntimeContextMessages(
      selectRuntimeContextWindow(
        filterRuntimeContextMessagesForPrompt(messages, {
          lastCompactedMessageRowId: conversationState.lastCompactedMessageRowId,
          senderId: msg.senderId,
        }),
        contextLimit,
      ),
    ).trim()

  if (shouldUseSnapshot) {
    const runtimeSnapshot = await getRuntimeSnapshot(getGroupRuntimeKey(msg.groupId))
    const runtimeContextText = runtimeSnapshot ? renderRuntimeContextText(runtimeSnapshot.contextSnapshot.messages) : ''
    if (runtimeContextText) {
      lines.push(runtimeContextText)
    }
    return {
      contextText: lines.join('\n'),
      recentMessages: [],
    }
  }

  const rebuiltContext = await buildRuntimeContextFromLedgers({
    groupId: msg.groupId,
    scopeKey,
    contextLimit,
    lastCompactedMessageRowId: conversationState.lastCompactedMessageRowId,
    getRecentMessages,
    getMessagesAfterRowId,
    listReplyRecords,
    listReplyRecordsAfterRowId,
    resolveText: (message) => getStableResolvedText(message, options, dependencies),
  })
  const rebuiltRuntimeContextText = renderRuntimeContextText(rebuiltContext.runtimeMessages)
  if (rebuiltRuntimeContextText) {
    lines.push(rebuiltRuntimeContextText)
  }

  return { contextText: lines.join('\n'), recentMessages: rebuiltContext.recentMessages }
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
