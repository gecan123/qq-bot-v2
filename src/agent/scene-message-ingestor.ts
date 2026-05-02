import {
  freezeResolvedTextIfUnset,
  getGroupMessagesAfterRowId,
  getRecentGroupMessages,
  getRecentSceneMessages,
  getSceneMessagesAfterRowId,
  type MessageSceneKind,
} from '../database/messages.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { resolveMessage } from '../media/message-resolver.js'
import { getActionRecordAnchor, getActionRecordText } from '../runtime/action-record-payload.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { Message } from '../generated/prisma/client.js'
import type { ActionRecord, SceneId } from '../runtime/agent-runtime-types.js'
import type { AgentContext } from './agent-context.js'

/**
 * 把还没进 AgentContext 的群消息和已 sent 的 bot 回复一次性 append 进 context。
 *
 * 每次 @ 触发前调用一次, 形成「我上次看到 N, 这次看到 N+k」的增量摄入。
 * 摄入时按 anchor (messages.id / actionRecord.anchor) 升序穿插, 群友消息走 user role,
 * bot 回复走 model role, 严格 append-only — 不会改写已有 context messages。
 *
 * 媒体文本 append 时刻冻结:走 messages.resolvedText, 没有则即时 resolve + freeze。
 * 之后即使 messages 行被回填也不重写 AgentContext (这是永续上下文的关键不变量)。
 *
 * 边界:
 * - upToExclusiveRowId 不为空时, 只摄入 < 该 rowId 的消息 (用于摄入到 trigger 之前)
 * - 冷启动 (lastObserved == 0) 时用 getRecent* 拉取最近 maxColdStartMessages 条
 * - 增量启动用 getMessagesAfterRowId, 不再做 contextLimit 削顶 (永续 append-only)
 */

export interface IngestSceneMessagesParams {
  context: AgentContext
  sceneKind: MessageSceneKind
  sceneExternalId: string | number
  sceneId: SceneId
  groupId: number
  /**
   * 只摄入 messageRowId < 该值 的群消息, 让调用方自己处理 trigger。
   * 不传 = 摄入到当前最新。
   */
  upToExclusiveRowId?: number
  maxColdStartMessages?: number
  dependencies?: IngestDependencies
}

export interface IngestDependencies {
  getRecentGroupMessages?: typeof getRecentGroupMessages
  getRecentSceneMessages?: typeof getRecentSceneMessages
  getGroupMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getSceneMessagesAfterRowId?: typeof getSceneMessagesAfterRowId
  listSentActionRecordsForScene?: typeof listSentActionRecordsForScene
  resolveMessage?: typeof resolveMessage
  freezeResolvedTextIfUnset?: typeof freezeResolvedTextIfUnset
}

const DEFAULT_COLD_START_CAP = 20

export async function ingestSceneMessages(params: IngestSceneMessagesParams): Promise<void> {
  const deps = params.dependencies ?? {}
  const cursor = params.context.getLastObservedMessageRowId()
  const cap = params.maxColdStartMessages ?? DEFAULT_COLD_START_CAP

  const messages = await fetchIncomingMessages({
    cursor,
    cap,
    sceneKind: params.sceneKind,
    sceneExternalId: params.sceneExternalId,
    groupId: params.groupId,
    deps,
  })

  const filteredMessages = params.upToExclusiveRowId == null
    ? messages
    : messages.filter((message) => message.id < params.upToExclusiveRowId!)

  if (filteredMessages.length === 0) return

  const minRowId = Math.min(...filteredMessages.map((m) => m.id))
  const maxRowId = Math.max(...filteredMessages.map((m) => m.id))

  const listActionRecords = deps.listSentActionRecordsForScene ?? listSentActionRecordsForScene
  const allActionRecords = await listActionRecords(params.sceneId)
  const windowActionRecords = allActionRecords.filter((record) => {
    const anchor = getActionRecordAnchor(record)
    return anchor != null
      && anchor >= minRowId
      && anchor <= maxRowId
      && (record.deliveryState === 'sent' || record.deliveryState === 'acked')
  })

  await appendInOrder({
    context: params.context,
    messages: filteredMessages,
    actionRecords: windowActionRecords,
    deps,
  })

  await params.context.setLastObservedMessageRowId(maxRowId)
}

interface FetchParams {
  cursor: number
  cap: number
  sceneKind: MessageSceneKind
  sceneExternalId: string | number
  groupId: number
  deps: IngestDependencies
}

async function fetchIncomingMessages(params: FetchParams): Promise<Message[]> {
  if (params.cursor === 0) {
    if (params.sceneKind === 'qq_group') {
      const fn = params.deps.getRecentGroupMessages ?? getRecentGroupMessages
      return fn(params.groupId, params.cap)
    }
    const fn = params.deps.getRecentSceneMessages ?? getRecentSceneMessages
    return fn(params.sceneKind, params.sceneExternalId, params.cap)
  }

  if (params.sceneKind === 'qq_group') {
    const fn = params.deps.getGroupMessagesAfterRowId ?? getGroupMessagesAfterRowId
    return fn(params.groupId, params.cursor)
  }
  const fn = params.deps.getSceneMessagesAfterRowId ?? getSceneMessagesAfterRowId
  return fn(params.sceneKind, params.sceneExternalId, params.cursor)
}

interface AppendInOrderParams {
  context: AgentContext
  messages: Message[]
  actionRecords: ActionRecord[]
  deps: IngestDependencies
}

type Entry =
  | { kind: 'message'; anchor: number; createdAt: Date; message: Message }
  | { kind: 'action'; anchor: number; createdAt: Date; record: ActionRecord; text: string }

async function appendInOrder(params: AppendInOrderParams): Promise<void> {
  const entries: Entry[] = []
  for (const message of params.messages) {
    entries.push({
      kind: 'message',
      anchor: message.id,
      createdAt: message.sentAt ?? message.createdAt,
      message,
    })
  }
  for (const record of params.actionRecords) {
    const anchor = getActionRecordAnchor(record)
    if (anchor == null) continue
    const text = getActionRecordText(record)
    if (!text) continue
    entries.push({
      kind: 'action',
      anchor,
      createdAt: record.createdAt,
      record,
      text,
    })
  }

  entries.sort((a, b) => a.anchor - b.anchor || a.createdAt.getTime() - b.createdAt.getTime())

  const resolveFn = params.deps.resolveMessage ?? resolveMessage
  const freezeFn = params.deps.freezeResolvedTextIfUnset ?? freezeResolvedTextIfUnset

  for (const entry of entries) {
    if (entry.kind === 'message') {
      const text = await getStableResolvedText(entry.message, resolveFn, freezeFn)
      if (!text) continue
      const nickname = entry.message.senderGroupNickname
        ?? entry.message.senderNickname
        ?? String(entry.message.senderId)
      await params.context.appendUserMessage({
        role: 'user',
        content: `${nickname}: ${text}`,
      })
    } else {
      await params.context.appendAssistantTurn({
        role: 'model',
        content: entry.text,
      })
    }
  }
}

async function getStableResolvedText(
  message: Message,
  resolveFn: typeof resolveMessage,
  freezeFn: typeof freezeResolvedTextIfUnset,
): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen
  const segments = await resolveFn(message, { timeoutMs: 0 })
  const text = segmentsToPlainText(segments).trim()
  await freezeFn(message.id, text)
  return text
}
