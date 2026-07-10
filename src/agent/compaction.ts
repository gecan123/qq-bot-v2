import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { createLlmClient } from './llm-client.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { recordTokenUsage } from './token-stats.js'

const DEFAULT_COMPACTION_TRIGGER_TOKENS = 16_000
const DEFAULT_COMPACTION_KEEP_RATIO = 0.1
const SUMMARY_HEAD_PREFIX = '[历史摘要]\n'

const log = createLogger('COMPACTION')

const SUMMARIZER_SYSTEM_PROMPT = `
你是一个对话摘要助手。把以下历史对话压缩成结构化摘要。

按以下分类分段输出（每段可为空但标题必须保留）：

## 讨论过的话题
已讨论的话题和结论，按时间顺序。

## 群友信息
提到的群友偏好、性格特点、关系动态。用 QQ 号标识（不是昵称）。

## 我的承诺和状态
我（assistant）说过、承诺过、正在进行的事。

## 工具调用结果
关键的工具查询结果（股票、网页、图片描述等）的摘要。

## 情绪和氛围
当前对话的整体氛围、群友的情绪状态。

规则：
- 如果给了 [上次摘要]，合并新旧信息，不要简单 append
- 忽略客套、口水、未展开的玩笑
- 每段控制在 200 字以内，总摘要不超过 800 字
- 不要回应或继续对话，直接输出摘要
`.trim()

const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成结构化中文摘要。'

export interface SummarizeInput {
  previousSummary: string | null
  history: AgentMessage[]
}

export type SummarizeFn = (input: SummarizeInput) => Promise<string>

export interface MaybeCompactOptions {
  summarize?: SummarizeFn
  triggerTokens?: number
  keepRatio?: number
}

export function findSafeCutIndex(messages: AgentMessage[], keepCount: number): number {
  if (messages.length <= keepCount) return 0
  let cut = messages.length - keepCount
  if (cut <= 0) return 0

  while (cut > 0) {
    const headOfTail = messages[cut]
    if (headOfTail?.role === 'tool') {
      cut--
      continue
    }
    const before = messages[cut - 1]
    if (before?.role === 'assistant' && before.toolCalls.length > 0) {
      cut--
      continue
    }
    break
  }
  return cut
}

function splitExistingSummary(messages: AgentMessage[]): {
  previousSummary: string | null
  rest: AgentMessage[]
} {
  const head = messages[0]
  if (head?.role !== 'user' || !head.content.startsWith(SUMMARY_HEAD_PREFIX)) {
    return { previousSummary: null, rest: messages }
  }
  return {
    previousSummary: head.content.slice(SUMMARY_HEAD_PREFIX.length).trim(),
    rest: messages.slice(1),
  }
}

function stripImagesForSummary(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.nativeBlocks !== undefined) {
      return {
        role: 'assistant',
        content: m.content,
        toolCalls: m.toolCalls,
      }
    }
    if (m.role !== 'tool' || typeof m.content === 'string') return m
    return {
      ...m,
      content: m.content.map((block) =>
        block.type === 'text' ? block : { type: 'text' as const, text: '[图片]' },
      ),
    }
  })
}

function stripInactiveNativeBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => {
    if (
      message.role !== 'assistant' ||
      message.nativeBlocks === undefined ||
      isActiveToolCycleAtTail(messages, index)
    ) {
      return message
    }
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls,
    }
  })
}

function isActiveToolCycleAtTail(messages: AgentMessage[], index: number): boolean {
  const message = messages[index]
  if (!message || message.role !== 'assistant' || message.toolCalls.length === 0) {
    return false
  }

  const pendingToolCallIds = new Set(message.toolCalls.map((call) => call.id))
  let cursor = index + 1
  while (cursor < messages.length) {
    const next = messages[cursor]
    if (!next || next.role !== 'tool' || !pendingToolCallIds.has(next.toolCallId)) break
    pendingToolCallIds.delete(next.toolCallId)
    cursor += 1
  }

  return pendingToolCallIds.size === 0 && cursor === messages.length
}

async function defaultSummarize(input: SummarizeInput): Promise<string> {
  const llm = createLlmClient()

  const messages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) {
    messages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  }
  messages.push(...stripImagesForSummary(input.history))
  messages.push({ role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })

  const result = await llm.chat({
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages,
    tools: [],
  })

  recordTokenUsage({
    operation: 'compaction',
    inputTokens: result.usage.inputTokens,
    cachedTokens: result.usage.cachedTokens,
    outputTokens: result.usage.outputTokens,
    model: result.model,
  })

  if (result.content.length === 0) {
    log.warn({}, 'summarizer_empty_response')
    return ''
  }
  return result.content.trim()
}

export async function maybeCompactConversation(
  context: AgentContext,
  lastInputTokens: number | null,
  options: MaybeCompactOptions = {},
): Promise<void> {
  if (lastInputTokens == null) return

  const summarize = options.summarize ?? defaultSummarize
  const triggerTokens = options.triggerTokens ?? config.compactionTriggerTokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS
  const keepRatio = options.keepRatio ?? DEFAULT_COMPACTION_KEEP_RATIO

  if (lastInputTokens <= triggerTokens) return

  const snapshot = context.getSnapshot()

  log.info(
    { inputTokens: lastInputTokens, messageCount: snapshot.messages.length, triggerTokens },
    'compaction_triggered',
  )

  const keepCount = Math.max(1, Math.ceil(snapshot.messages.length * keepRatio))
  const cutIndex = findSafeCutIndex(snapshot.messages, keepCount)
  if (cutIndex <= 0) {
    log.warn(
      { inputTokens: lastInputTokens, messageCount: snapshot.messages.length, keepCount },
      'compaction_no_safe_cut',
    )
    return
  }

  const toCompress = snapshot.messages.slice(0, cutIndex)
  const tail = stripInactiveNativeBlocks(snapshot.messages.slice(cutIndex))
  const { previousSummary, rest: historyToSummarize } = splitExistingSummary(toCompress)

  if (historyToSummarize.length === 0 && !previousSummary) {
    return
  }

  let newSummary: string
  try {
    newSummary = await summarize({
      previousSummary,
      history: stripImagesForSummary(historyToSummarize),
    })
  } catch (err) {
    log.error({ err, inputTokens: lastInputTokens, cutIndex }, 'summarizer_failed_emergency_truncation')
    newSummary = previousSummary ?? '(历史消息因超长被应急截断)'
  }
  if (!newSummary.trim()) {
    log.warn({ inputTokens: lastInputTokens, cutIndex, tailLen: tail.length }, 'compaction_skipped_empty_summary')
    return
  }

  const summaryMessage: AgentMessage = {
    role: 'user',
    content: `${SUMMARY_HEAD_PREFIX}${newSummary.trim()}`,
  }
  context.replaceMessages([summaryMessage, ...tail])

  log.info(
    {
      previousMessages: snapshot.messages.length,
      newMessages: 1 + tail.length,
      compressedCount: toCompress.length,
      keptCount: tail.length,
      inputTokensBefore: lastInputTokens,
    },
    'compaction_replaced',
  )
}
