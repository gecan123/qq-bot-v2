import { freezeResolvedTextIfUnset, getGroupMessagesAfterRowId } from '../database/messages.js'
import { listSentActionRecordsForScene } from '../runtime/agent-runtime-store.js'
import { makeQqGroupSceneId, type ActionRecord } from '../runtime/agent-runtime-types.js'
import { getActionRecordAnchor, getActionRecordText } from '../runtime/action-record-payload.js'
import { compactConversationState, getOrCreateConversationState } from './conversation-state-store.js'
import { resolveMessage } from '../media/message-resolver.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { agentClient, agentModel } from '../agent/runtime.js'
import { toOpenAIMessages } from '../agent/openai-compat.js'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import type { Message } from '../generated/prisma/client.js'
import type { AgentMessage } from '../agent/types.js'

/**
 * Phase 1.5: 阈值上调, 让 perpetual append + cache 撑得更久。
 * compaction 是计划性破坏前缀的"昂贵操作", 频率越低越好。
 */
const COMPACTION_TRIGGER_USER_MESSAGES = 80
const COMPACTION_KEEP_RECENT_USER_MESSAGES = 20

const log = createLogger('COMPACTION')

const SUMMARIZER_SYSTEM_PROMPT = `
你是一个对话摘要助手。接下来会喂给你一段历史对话片段, 由群聊用户消息 (user role) 和你过去发出去的回复 (assistant role) 组成。

你的任务: 把这段对话压缩成简洁的中文摘要, 只保留:
- 已被讨论的话题和结论
- 重要事实、意图、情绪
- 你自己 (assistant 角色) 说过 / 承诺过的事

忽略: 客套、口水、未展开的玩笑、被覆盖的旧话题。

如果给你了 [上次摘要], 把它和新对话合并成新摘要, 不要简单 append。

输出: 仅一段连贯的中文文本, 不要标题不要列表, 控制在 400 字以内。
不要回应或继续对话。直接输出摘要。
`.trim()

const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成中文摘要。'

export interface SummarizeInput {
  previousSummary: string | null
  history: AgentMessage[]
}

export type SummarizeFn = (input: SummarizeInput) => Promise<string>

export interface MaybeCompactOptions {
  /**
   * 测试可注入。生产默认走内嵌 OpenAI-compatible 调用 (复用 agentClient/agentModel)。
   * 不引入 ConversationSummarizer 接口 —— 当前没有第二实现, 函数注入足够。
   */
  summarize?: SummarizeFn
  /** 测试覆盖阈值。生产默认 80 条触发, 保留最近 20 条。 */
  triggerThreshold?: number
  keepRecentCount?: number
  // 下面的 hooks 留给单测覆盖 IO; 生产不需要传。
  getConversationState?: typeof getOrCreateConversationState
  getMessagesAfterRowId?: typeof getGroupMessagesAfterRowId
  getActionRecordsForScene?: typeof listSentActionRecordsForScene
  resolveConversationMessage?: typeof resolveMessage
  freezeResolvedText?: typeof freezeResolvedTextIfUnset
  saveCompactedState?: typeof compactConversationState
}

async function getStableCompactionText(
  message: Message,
  resolveFn: typeof resolveMessage,
  freezeFn: typeof freezeResolvedTextIfUnset,
): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen

  const resolvedSegments = await resolveFn(message, { timeoutMs: 0 })
  const resolvedText = segmentsToPlainText(resolvedSegments).trim()
  await freezeFn(message.id, resolvedText)
  return resolvedText
}

/**
 * 把要压的 messages + actionRecords 渲染成真多轮 AgentMessage[]。
 * 跟 context-builder.renderWindowAsMessages 同构, 但不限 contextLimit。
 * bot 已发送内容必须以 model role 进入摘要, 不做 [BOT] xxx 文本拼接。
 */
async function renderHistoryToCompress(
  messages: Message[],
  actionRecords: ActionRecord[],
  resolveFn: typeof resolveMessage,
  freezeFn: typeof freezeResolvedTextIfUnset,
): Promise<AgentMessage[]> {
  type Entry = { anchor: number; createdAt: Date; message: AgentMessage }
  const entries: Entry[] = []

  for (const message of messages) {
    const text = await getStableCompactionText(message, resolveFn, freezeFn)
    if (!text) continue
    const nickname = message.senderGroupNickname ?? message.senderNickname ?? String(message.senderId)
    entries.push({
      anchor: message.id,
      createdAt: message.sentAt ?? message.createdAt,
      message: { role: 'user', content: `${nickname}: ${text}` },
    })
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

/**
 * 默认 summarize 实现: 复用 agentClient / agentModel 直接发一次 OpenAI-compatible 请求。
 * previousSummary 是合并输入, 不是 append; 由 system prompt 指令保证。
 */
async function defaultSummarize(input: SummarizeInput): Promise<string> {
  const messages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) messages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  messages.push(...input.history)
  messages.push({ role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })

  const response = await agentClient.chat.completions.create({
    model: agentModel,
    temperature: 0.3,
    messages: toOpenAIMessages(SUMMARIZER_SYSTEM_PROMPT, messages),
  })
  recordCurrentTokenUsage('compaction.summarize', toTokenUsage(response.usage))

  const content = response.choices[0]?.message?.content
  if (typeof content !== 'string') {
    log.warn({ choices: response.choices.length }, 'summarizer_empty_response')
    return ''
  }
  return content.trim()
}

/**
 * 仅当新消息累计超过阈值时, 用 LLM 把旧片段压成一段摘要并写回 conversation_state。
 *
 * 不变量 (修改时务必保留):
 *   1. 摘要前先 resolve + freeze 媒体文本, 防止之后媒体描述变化重写历史前缀。
 *   2. bot 已发送内容以 model role 进入 summarizer, 不退化成 [BOT] 文本拼接。
 *   3. previousSummary 是合并输入, 不是 append (由 system prompt 约束 + 单测验证)。
 *   4. summarize 返回空白时不写回状态。
 *   5. post-send 调用方需 try/catch, compaction 失败不能污染已 sent reply。
 */
export async function maybeCompactConversation(
  groupId: number,
  senderThreadKey: string,
  options: MaybeCompactOptions = {},
): Promise<void> {
  const getConversationState = options.getConversationState ?? getOrCreateConversationState
  const getMessagesAfterRowId = options.getMessagesAfterRowId ?? getGroupMessagesAfterRowId
  const getActionRecordsForScene = options.getActionRecordsForScene ?? listSentActionRecordsForScene
  const resolveFn = options.resolveConversationMessage ?? resolveMessage
  const freezeFn = options.freezeResolvedText ?? freezeResolvedTextIfUnset
  const saveCompactedState = options.saveCompactedState ?? compactConversationState
  const summarize = options.summarize ?? defaultSummarize
  const triggerThreshold = options.triggerThreshold ?? COMPACTION_TRIGGER_USER_MESSAGES
  const keepRecentCount = options.keepRecentCount ?? COMPACTION_KEEP_RECENT_USER_MESSAGES

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

  const history = await renderHistoryToCompress(
    compactedMessages,
    compactedActionRecords,
    resolveFn,
    freezeFn,
  )
  if (history.length === 0) return

  const newSummary = await summarize({
    previousSummary: state.compactedBase.trim() || null,
    history,
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
