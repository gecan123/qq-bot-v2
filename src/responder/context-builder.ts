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

function actionRecordText(actionRecord: ActionRecord): string | null {
  if (actionRecord.deliveryState !== 'sent' && actionRecord.deliveryState !== 'acked') return null
  const text = getActionRecordText(actionRecord)
  return text ? `[BOT] ${text}` : null
}

async function renderConversationWindow(
  messages: Message[],
  actionRecords: ActionRecord[],
  contextLimit: number,
  options: ContextBuildOptions,
  dependencies: ContextBuildDependencies,
): Promise<string> {
  const rendered: Array<{ anchor: number; createdAt: Date; text: string }> = []
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
      rendered.push({
        anchor: dbMsg.id,
        createdAt: dbMsg.sentAt ?? dbMsg.createdAt,
        text: `[QQ消息]\n${nickname}: ${text}`,
      })
    }

    while (actionIndex < sortedActions.length) {
      const actionRecord = sortedActions[actionIndex]
      const anchor = actionRecord ? getActionRecordAnchor(actionRecord) : null
      if (!actionRecord || anchor == null || anchor > dbMsg.id) break
      const text = actionRecordText(actionRecord)
      if (text) rendered.push({ anchor, createdAt: actionRecord.createdAt, text })
      actionIndex++
    }
  }

  while (actionIndex < sortedActions.length) {
    const actionRecord = sortedActions[actionIndex]
    const anchor = actionRecord ? getActionRecordAnchor(actionRecord) : null
    const text = actionRecord ? actionRecordText(actionRecord) : null
    if (actionRecord && anchor != null && text) {
      rendered.push({ anchor, createdAt: actionRecord.createdAt, text })
    }
    actionIndex++
  }

  return rendered
    .sort((a, b) => a.anchor - b.anchor || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-contextLimit)
    .map((entry) => entry.text)
    .join('\n')
}

export async function buildContext(
  msg: IncomingMessage,
  contextLimit: number,
  options: ContextBuildOptions = {},
  dependencies: ContextBuildDependencies = {},
): Promise<BuildContextResult> {
  const lines: string[] = []
  const scene = resolveIncomingScene(msg)
  const scopeKey = toSceneReplyScopeKey(scene.sceneId)
  const conversationStateGroupId = scene.sceneKind === 'qq_private' ? 0 : msg.groupId
  const getConversationState = dependencies.getConversationState ?? getOrCreateConversationState
  const listActionRecords = dependencies.listActionRecords ?? listSentActionRecordsForScene
  const conversationState = await getConversationState(conversationStateGroupId, scopeKey)

  if (conversationState.compactedBase.trim()) {
    lines.push('[压缩上下文]')
    lines.push(conversationState.compactedBase.trim())
    lines.push('')
  }

  const quoted = msg.segments.find((segment): segment is ReplySegment => segment.type === 'reply')
  if (quoted) {
    const quotedMessage = await getStoredMessageForIncoming(msg, Number(quoted.messageId), dependencies)
    if (quotedMessage) {
      const nickname = quotedMessage.senderGroupNickname ?? quotedMessage.senderNickname
      const text = await getStableResolvedText(quotedMessage, options, dependencies)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
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

  const windowText = await renderConversationWindow(
    contextMessages.slice(-contextLimit),
    windowActionRecords,
    contextLimit,
    options,
    dependencies,
  )
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
