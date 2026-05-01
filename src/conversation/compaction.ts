import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId } from '../database/messages.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId, type ActionRecord } from '../runtime/agent-runtime-types.js'
import { getActionRecordAnchor, getActionRecordText } from '../runtime/action-record-payload.js'
import { compactConversationState, getOrCreateConversationState } from './conversation-state-store.js'
import { resolveMessage } from '../media/message-resolver.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { createLogger } from '../logger.js'
import type { Message } from '../generated/prisma/client.js'
import type { AgentMessage } from '../agent/types.js'
import type { ConversationSummarizer } from './summarizer.js'

/**
 * Phase 1.5: 阈值上调, 让 perpetual append + cache 撑得更久。
 * compaction 是计划性破坏前缀的"昂贵操作", 频率越低越好。
 */
const COMPACTION_TRIGGER_USER_MESSAGES = 80
const COMPACTION_KEEP_RECENT_USER_MESSAGES = 20

const log = createLogger('COMPACTION')

interface CompactionDependencies {
  getConversationState?: typeof getOrCreateConversationState
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getActionRecordsForScene?: typeof listSentActionRecordsForScene
  resolveConversationMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
  saveCompactedState?: typeof compactConversationState
  /**
   * Phase 1.5: 必须由调用方注入。compaction 不再做 text concat,
   * 而是把要压的真多轮 history 喂给 summarizer 产生新 summary,
   * 一次性 replace conversationState.compactedBase。
   *
   * 测试里可注入 stub: { summarize: async () => 'mock summary' }。
   * 生产侧用 src/conversation/openai-summarizer.ts 的 createOpenAISummarizer()。
   */
  summarizer?: ConversationSummarizer
  /** 测试覆盖阈值。生产默认 80 条触发, 保留最近 20 条。 */
  triggerThreshold?: number
  keepRecentCount?: number
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

/**
 * Phase 1.5: 把要压的 messages + actionRecords 渲染成真多轮 AgentMessage[],
 * 然后喂给 summarizer。
 *
 * 跟 context-builder.renderWindowAsMessages 同构, 但这里不限制 contextLimit
 * (compaction 处理的是历史全段, 不是 window)。
 */
async function renderHistoryToCompress(
  messages: Message[],
  actionRecords: ActionRecord[],
  dependencies: CompactionDependencies,
): Promise<AgentMessage[]> {
  type Entry = { anchor: number; createdAt: Date; message: AgentMessage }
  const entries: Entry[] = []

  for (const message of messages) {
    const text = await getStableCompactionText(message, dependencies)
    const nickname = message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId)
    if (text) {
      entries.push({
        anchor: message.id,
        createdAt: message.sentAt ?? message.createdAt,
        message: { role: 'user', content: `${nickname}: ${text}` },
      })
    }
  }

  for (const actionRecord of actionRecords) {
    const anchor = getActionRecordAnchor(actionRecord)
    if (anchor == null) continue
    if (actionRecord.deliveryState !== 'sent' && actionRecord.deliveryState !== 'acked') continue
    const text = getActionRecordText(actionRecord)
    if (!text) continue
    entries.push({
      anchor,
      createdAt: actionRecord.createdAt,
      message: { role: 'model', content: text },
    })
  }

  return entries
    .sort((a, b) => a.anchor - b.anchor || a.createdAt.getTime() - b.createdAt.getTime())
    .map((entry) => entry.message)
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
  const triggerThreshold = dependencies.triggerThreshold ?? COMPACTION_TRIGGER_USER_MESSAGES
  const keepRecentCount = dependencies.keepRecentCount ?? COMPACTION_KEEP_RECENT_USER_MESSAGES

  const state = await getConversationState(groupId, senderThreadKey)
  const lastCompactedMessageRowId = state.lastCompactedMessageRowId ?? 0
  const messages = await getMessagesAfterRowId(groupId, lastCompactedMessageRowId)
  if (messages.length <= triggerThreshold) return

  const boundaryMessage = messages[messages.length - keepRecentCount - 1]
  if (!boundaryMessage) return

  const actionRecords = await getActionRecordsForScene(makeQqGroupSceneId(groupId))
  const compactedMessages = messages.filter((message) => message.id <= boundaryMessage.id)
  const compactedActionRecords = actionRecords.filter((record) => {
    const anchor = getActionRecordAnchor(record)
    return anchor != null && anchor > lastCompactedMessageRowId && anchor <= boundaryMessage.id
  })

  const historyToCompress = await renderHistoryToCompress(
    compactedMessages,
    compactedActionRecords,
    dependencies,
  )
  if (historyToCompress.length === 0) return

  if (!dependencies.summarizer) {
    log.warn(
      { groupId, senderThreadKey, historyLen: historyToCompress.length },
      'compaction_skipped_no_summarizer',
    )
    return
  }

  const newSummary = await dependencies.summarizer.summarize({
    previousSummary: state.compactedBase.trim() || null,
    historyToCompress,
  })
  if (!newSummary.trim()) {
    log.warn({ groupId, senderThreadKey }, 'compaction_skipped_empty_summary')
    return
  }

  await saveCompactedState({
    groupId,
    senderThreadKey,
    compactedBase: newSummary,
    lastCompactedMessageRowId: boundaryMessage.id,
  })
}
