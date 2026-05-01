import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import {
  freezeResolvedTextIfUnset,
  getGroupMessagesAfterRowId,
  getRecentGroupMessages,
  getMessageById,
  getMessageBySceneMessageId,
  getRecentSceneMessages,
  getSceneMessagesAfterRowId,
  type MessageSceneKind,
} from '../database/messages.js'
import { getOrCreateConversationState } from '../conversation/conversation-state-store.js'
import { toSceneReplyScopeKey } from '../conversation/reply-scope.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId, makeQqPrivateSceneId, type SceneId } from '../runtime/agent-runtime-types.js'
import type { ActionRecord } from '../runtime/agent-runtime-types.js'
import { getActionRecordAnchor, getActionRecordText } from '../runtime/action-record-payload.js'
import type { AgentMessage } from '../agent/types.js'

export interface BuildContextResult {
  history: AgentMessage[]
  compactedSummary?: string
  recentMessages: Message[]
  messageCursorStart?: number
  messageCursorEnd?: number
  includedActionRecordIds?: string[]
  maxActionAnchor?: number
  compactionSegmentIds?: string[]
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
  getRecentSceneMessages?: typeof getRecentSceneMessages
  getSceneMessagesAfterRowId?: typeof getSceneMessagesAfterRowId
  getStoredMessage?: typeof getMessageById
  resolveStoredMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
  listActionRecords?: typeof listSentActionRecordsForScene
}

function resolveIncomingScene(msg: IncomingMessage): {
  sceneKind: MessageSceneKind
  sceneExternalId: string
  sceneId: SceneId
} {
  if (msg.sceneKind === 'qq_private') {
    const sceneExternalId = msg.sceneExternalId ?? String(msg.senderId)
    return {
      sceneKind: 'qq_private',
      sceneExternalId,
      sceneId: (msg.sceneId as SceneId | undefined) ?? makeQqPrivateSceneId(sceneExternalId),
    }
  }

  const sceneExternalId = msg.sceneExternalId ?? String(msg.groupId)
  return {
    sceneKind: 'qq_group',
    sceneExternalId,
    sceneId: (msg.sceneId as SceneId | undefined) ?? makeQqGroupSceneId(sceneExternalId),
  }
}

async function getStoredMessageForIncoming(
  msg: IncomingMessage,
  messageId: number,
  dependencies: ContextBuildDependencies,
): Promise<Message | null> {
  const scene = resolveIncomingScene(msg)
  if (scene.sceneKind === 'qq_group') {
    const getStoredMessage = dependencies.getStoredMessage ?? getMessageById
    return getStoredMessage(msg.groupId, messageId)
  }
  return getMessageBySceneMessageId({
    sceneKind: scene.sceneKind,
    sceneExternalId: scene.sceneExternalId,
    messageId,
  })
}

async function getRecentMessagesForIncoming(
  msg: IncomingMessage,
  contextLimit: number,
  afterRowId: number | undefined,
  dependencies: ContextBuildDependencies,
): Promise<Message[]> {
  const scene = resolveIncomingScene(msg)
  if (scene.sceneKind === 'qq_group') {
    const getRecentMessages = dependencies.getRecentMessages ?? getRecentGroupMessages
    const getMessagesAfterRowId = dependencies.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
    return afterRowId
      ? getMessagesAfterRowId(msg.groupId, afterRowId)
      : getRecentMessages(msg.groupId, contextLimit)
  }

  const getRecentMessages = dependencies.getRecentSceneMessages ?? getRecentSceneMessages
  const getMessagesAfterRowId = dependencies.getSceneMessagesAfterRowId ?? getSceneMessagesAfterRowId
  return afterRowId
    ? getMessagesAfterRowId(scene.sceneKind, scene.sceneExternalId, afterRowId)
    : getRecentMessages(scene.sceneKind, scene.sceneExternalId, contextLimit)
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

/**
 * 把 messages + actionRecords 渲染成真多轮 AgentMessage[]。
 * - 群友消息 → role: 'user'
 * - 已 sent/acked 的 action_record (bot 发出去的回复) → role: 'model'
 * - 按 anchor (messageRowId) 顺序穿插
 *
 * Phase 1.5 P1.1 修复:
 * 不再 slice(-contextLimit)。lastCompactedMessageRowId 之后的所有 entries 全部进 history。
 * 让 windowHistory 真正 append-only — 新消息只在末尾增加, 头部稳定, cache 在 system + summary
 * + windowHistory 全段都能命中。contextLimit 只用于 cold-start 限定 fetch 量, 不再削顶。
 */
export async function renderWindowAsMessages(
  messages: Message[],
  actionRecords: ActionRecord[],
  options: ContextBuildOptions,
  dependencies: ContextBuildDependencies,
): Promise<AgentMessage[]> {
  type Entry = { anchor: number; createdAt: Date; message: AgentMessage }
  const entries: Entry[] = []
  const sortedActions = [...actionRecords].sort((a, b) => {
    const left = getActionRecordAnchor(a) ?? Number.MAX_SAFE_INTEGER
    const right = getActionRecordAnchor(b) ?? Number.MAX_SAFE_INTEGER
    return left - right || a.createdAt.getTime() - b.createdAt.getTime()
  })
  let actionIndex = 0

  for (const dbMsg of messages) {
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname ?? String(dbMsg.senderId)
    const text = await getStableResolvedText(dbMsg, options, dependencies)
    if (text.trim()) {
      entries.push({
        anchor: dbMsg.id,
        createdAt: dbMsg.sentAt ?? dbMsg.createdAt,
        message: { role: 'user', content: `${nickname}: ${text}` },
      })
    }

    while (actionIndex < sortedActions.length) {
      const actionRecord = sortedActions[actionIndex]
      const anchor = actionRecord ? getActionRecordAnchor(actionRecord) : null
      if (!actionRecord || anchor == null || anchor > dbMsg.id) break
      if (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked') {
        const text = getActionRecordText(actionRecord)
        if (text) {
          entries.push({
            anchor,
            createdAt: actionRecord.createdAt,
            message: { role: 'model', content: text },
          })
        }
      }
      actionIndex++
    }
  }

  while (actionIndex < sortedActions.length) {
    const actionRecord = sortedActions[actionIndex]
    const anchor = actionRecord ? getActionRecordAnchor(actionRecord) : null
    if (
      actionRecord
      && anchor != null
      && (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked')
    ) {
      const text = getActionRecordText(actionRecord)
      if (text) {
        entries.push({
          anchor,
          createdAt: actionRecord.createdAt,
          message: { role: 'model', content: text },
        })
      }
    }
    actionIndex++
  }

  return entries
    .sort((a, b) => a.anchor - b.anchor || a.createdAt.getTime() - b.createdAt.getTime())
    .map((entry) => entry.message)
}

export async function buildContext(
  msg: IncomingMessage,
  contextLimit: number,
  options: ContextBuildOptions = {},
  dependencies: ContextBuildDependencies = {},
): Promise<BuildContextResult> {
  const scene = resolveIncomingScene(msg)
  const scopeKey = toSceneReplyScopeKey(scene.sceneId)
  const conversationStateGroupId = scene.sceneKind === 'qq_private' ? 0 : msg.groupId
  const getConversationState = dependencies.getConversationState ?? getOrCreateConversationState
  const listActionRecords = dependencies.listActionRecords ?? listSentActionRecordsForScene
  const conversationState = await getConversationState(conversationStateGroupId, scopeKey)

  const quoted = msg.segments.find((segment): segment is ReplySegment => segment.type === 'reply')
  let quotedAgentMessage: AgentMessage | null = null
  if (quoted) {
    const quotedMessage = await getStoredMessageForIncoming(msg, Number(quoted.messageId), dependencies)
    if (quotedMessage) {
      const nickname = quotedMessage.senderGroupNickname ?? quotedMessage.senderNickname ?? String(quotedMessage.senderId)
      const text = await getStableResolvedText(quotedMessage, options, dependencies)
      quotedAgentMessage = {
        role: 'user',
        content: `[被引用消息] ${nickname}: ${text}`,
      }
    }
  }

  const recentMessages = conversationState.lastCompactedMessageRowId
    ? await getRecentMessagesForIncoming(msg, contextLimit, conversationState.lastCompactedMessageRowId, dependencies)
    : await getRecentMessagesForIncoming(msg, contextLimit, undefined, dependencies)
  const contextMessages = msg.messageRowId == null
    ? recentMessages
    : recentMessages.filter((dbMsg) => dbMsg.id !== msg.messageRowId)

  const actionRecords = await listActionRecords(scene.sceneId)
  const compactedBoundary = conversationState.lastCompactedMessageRowId ?? 0
  const currentBoundary = msg.messageRowId ?? Number.MAX_SAFE_INTEGER
  const windowActionRecords = actionRecords.filter((actionRecord) => {
    const anchor = getActionRecordAnchor(actionRecord)
    return anchor != null && anchor > compactedBoundary && anchor < currentBoundary
  })
  // Phase 1.5 P1.1: lastCompactedMessageRowId 之后的所有消息都进 window, 不再 slice。
  // contextLimit 仅在 cold start (没有 lastCompactedMessageRowId) 时控制初次 fetch 量,
  // 进 window 后不再削顶, 让前缀 append-only 真正稳定。
  const includedMessages = contextMessages
  const messageCursorStart = includedMessages.length > 0
    ? Math.min(...includedMessages.map((dbMsg) => dbMsg.id))
    : undefined
  const messageCursorEnd = includedMessages.length > 0
    ? Math.max(...includedMessages.map((dbMsg) => dbMsg.id))
    : undefined
  const actionAnchors = windowActionRecords
    .map((actionRecord) => getActionRecordAnchor(actionRecord))
    .filter((anchor): anchor is number => anchor != null)
  const maxActionAnchor = actionAnchors.length > 0 ? Math.max(...actionAnchors) : undefined

  const history = await renderWindowAsMessages(
    includedMessages,
    windowActionRecords,
    options,
    dependencies,
  )

  // 被引用消息作为 window 之前的独立 user message
  // 顺序保证: [被引用?] → window → (trigger 由 reply-history 在末尾追加)
  if (quotedAgentMessage) {
    history.unshift(quotedAgentMessage)
  }

  const compactedSummary = conversationState.compactedBase.trim() || undefined

  return {
    history,
    compactedSummary,
    recentMessages,
    messageCursorStart,
    messageCursorEnd,
    includedActionRecordIds: windowActionRecords.map((actionRecord) => actionRecord.id),
    maxActionAnchor,
    compactionSegmentIds: [],
  }
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segmentsToPlainText(segments.filter((s) => s.type !== 'reply'))
}

export async function extractResolvedTriggerText(
  groupId: number,
  messageId: number,
  fallbackSegments: ParsedSegment[],
  options: ContextBuildOptions = {},
  scene?: { sceneKind?: MessageSceneKind; sceneExternalId?: string | number },
): Promise<string> {
  const dbMsg = scene?.sceneKind === 'qq_private'
    ? await getMessageBySceneMessageId({
        sceneKind: scene.sceneKind,
        sceneExternalId: scene.sceneExternalId ?? groupId,
        messageId,
      })
    : await getMessageById(groupId, messageId)
  if (!dbMsg) return extractTriggerText(fallbackSegments)
  return getStableResolvedText(dbMsg, options)
}
