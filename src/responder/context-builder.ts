import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId, getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { listSentAssistantTurns, listSentAssistantTurnsAfterMessageRowId } from '../conversation/assistant-turn-store.js'
import { getOrCreateConversationState } from '../conversation/conversation-state-store.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import { getRootRuntimeSnapshotByRuntimeKey } from '../runtime/snapshot-store.js'
import { getGroupRuntimeKey } from '../runtime/root-runtime.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { getMessageTimestamp } from '../utils/message-time.js'
import type { RuntimeContextMessage } from '../runtime/types.js'

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

interface ContextBuildDependencies {
  getConversationState?: typeof getOrCreateConversationState
  getRuntimeSnapshot?: typeof getRootRuntimeSnapshotByRuntimeKey
  getRecentMessages?: typeof getRecentGroupMessages
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  listAssistantTurns?: typeof listSentAssistantTurns
  listAssistantTurnsAfterRowId?: typeof listSentAssistantTurnsAfterMessageRowId
  getStoredMessage?: typeof getMessageById
  resolveStoredMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
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
  senderThreadKey: string
  conversationState: Awaited<ReturnType<typeof getOrCreateConversationState>>
  getStoredMessage: typeof getMessageById
  getRuntimeSnapshot: typeof getRootRuntimeSnapshotByRuntimeKey
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

  const senderContinuity = runtimeSnapshot.sessionSnapshot.senderContinuities.find(
    (continuity) => continuity.senderThreadKey === input.senderThreadKey,
  )
  const requiredMaterializedRowId = input.conversationState.lastIncorporatedMessageRowId ?? 0
  const materializedEnough = (senderContinuity?.lastMaterializedMessageRowId ?? 0) >= requiredMaterializedRowId

  return materializedEnough
}

export async function buildContext(
  msg: IncomingMessage,
  contextLimit: number,
  options: ContextBuildOptions = {},
  dependencies: ContextBuildDependencies = {},
): Promise<BuildContextResult> {
  const lines: string[] = []
  const senderThreadKey = toSenderThreadKey(msg.senderId)
  const getConversationState = dependencies.getConversationState ?? getOrCreateConversationState
  const getRuntimeSnapshot = dependencies.getRuntimeSnapshot ?? getRootRuntimeSnapshotByRuntimeKey
  const getStoredMessage = dependencies.getStoredMessage ?? getMessageById
  const getRecentMessages = dependencies.getRecentMessages ?? getRecentGroupMessages
  const getMessagesAfterRowId = dependencies.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const listAssistantTurns = dependencies.listAssistantTurns ?? listSentAssistantTurns
  const listAssistantTurnsAfterRowId = dependencies.listAssistantTurnsAfterRowId ?? listSentAssistantTurnsAfterMessageRowId
  const conversationState = await getConversationState(msg.groupId, senderThreadKey)

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
    senderThreadKey,
    conversationState,
    getStoredMessage,
    getRuntimeSnapshot,
  })
  if (shouldUseSnapshot) {
    const runtimeSnapshot = await getRuntimeSnapshot(getGroupRuntimeKey(msg.groupId))
    const runtimeContextText = runtimeSnapshot
      ? renderRuntimeContextMessages(
          selectRuntimeContextWindow(
            runtimeSnapshot.contextSnapshot.messages.filter(
              (message) =>
                conversationState.lastCompactedMessageRowId == null ||
                message.orderKey > conversationState.lastCompactedMessageRowId,
            ),
            contextLimit,
          ),
        )
      : ''
    lines.push(runtimeContextText.trim())
    return {
      contextText: lines.join('\n'),
      recentMessages: [],
    }
  }

  const recentMessages = conversationState.lastCompactedMessageRowId
    ? await getMessagesAfterRowId(msg.groupId, conversationState.lastCompactedMessageRowId)
    : await getRecentMessages(msg.groupId, contextLimit)
  const assistantTurns = conversationState.lastCompactedMessageRowId
    ? await listAssistantTurnsAfterRowId(msg.groupId, senderThreadKey, conversationState.lastCompactedMessageRowId)
    : await listAssistantTurns(msg.groupId, senderThreadKey)
  const resolvedRecentTexts: string[] = []
  for (const dbMsg of recentMessages) {
    resolvedRecentTexts.push(await getStableResolvedText(dbMsg, options, dependencies))
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
