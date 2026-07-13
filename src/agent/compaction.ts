import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { createLlmClient } from './llm-client.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { recordTokenUsage } from './token-stats.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { renderUntrustedTranscript } from './untrusted-transcript.js'
import {
  renderRestResumeReminderCompactionSuffix,
  stripRestResumeReminderCompactionSuffix,
} from './rest-resume-reminder.js'

const DEFAULT_COMPACTION_TRIGGER_TOKENS = 16_000
const DEFAULT_COMPACTION_TAIL_CHARS = 12_000
const MAX_SUMMARY_CHARS = 800
const SUMMARY_HEAD_PREFIX = '[历史摘要]\n'
const SUMMARY_HEADINGS = [
  '## 讨论过的话题',
  '## 群友信息',
  '## 我的承诺和状态',
  '## 工具调用结果',
  '## 情绪和氛围',
] as const

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
  tailMaxChars?: number
  /** 兼容测试/调用方；显式传入时转换为确定性的 serialized-char budget。 */
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
  const summaryWithoutRuntimeState = stripRestResumeReminderCompactionSuffix(head.content)
  return {
    previousSummary: summaryWithoutRuntimeState.slice(SUMMARY_HEAD_PREFIX.length).trim(),
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

function serializedMessageChars(message: AgentMessage): number {
  return JSON.stringify(message).length
}

function selectTailCutIndex(messages: AgentMessage[], options: MaybeCompactOptions): number {
  const totalChars = messages.reduce((sum, message) => sum + serializedMessageChars(message), 0)
  const explicitRatio = options.keepRatio
  const budget = Math.max(1, Math.floor(
    options.tailMaxChars
      ?? (explicitRatio == null
        ? DEFAULT_COMPACTION_TAIL_CHARS
        : totalChars * Math.min(1, Math.max(0, explicitRatio))),
  ))
  let keepChars = 0
  let cutIndex = messages.length
  while (cutIndex > 0) {
    const nextChars = serializedMessageChars(messages[cutIndex - 1]!)
    if (keepChars > 0 && keepChars + nextChars > budget) break
    keepChars += nextChars
    cutIndex--
    if (keepChars >= budget) break
  }

  const keepCount = messages.length - cutIndex
  cutIndex = findSafeCutIndex(messages, keepCount)
  const lastCompleteToolCycle = findLastCompleteToolCycleStart(messages)
  if (lastCompleteToolCycle != null && cutIndex > lastCompleteToolCycle) {
    cutIndex = lastCompleteToolCycle
  }
  return cutIndex
}

function findLastCompleteToolCycleStart(messages: AgentMessage[]): number | null {
  let latest: number | null = null
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || message.role !== 'assistant' || message.toolCalls.length === 0) continue
    const complete = message.toolCalls.every((call, offset) => {
      const result = messages[index + offset + 1]
      return result?.role === 'tool' && result.toolCallId === call.id
    })
    if (complete) latest = index
  }
  return latest
}

function validateSummary(summary: string): { ok: true; summary: string } | { ok: false; reason: string } {
  const trimmed = summary.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_SUMMARY_CHARS) return { ok: false, reason: 'too_long' }

  const lines = trimmed.split('\n').map((line) => line.trimEnd())
  let previousIndex = -1
  for (const heading of SUMMARY_HEADINGS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex > previousIndex && line === heading)
    if (index < 0) return { ok: false, reason: `missing_heading:${heading}` }
    previousIndex = index
  }
  const content = lines.filter((line) => !SUMMARY_HEADINGS.includes(line as typeof SUMMARY_HEADINGS[number]))
    .join('\n')
    .trim()
  if (!content) return { ok: false, reason: 'empty_sections' }
  return { ok: true, summary: trimmed }
}

async function defaultSummarize(input: SummarizeInput): Promise<string> {
  const llm = createLlmClient()

  const result = await llm.chat({
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages: buildCompactionSummarizerMessages(input),
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

export function buildCompactionSummarizerMessages(input: SummarizeInput): AgentMessage[] {
  const dataMessages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) dataMessages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  dataMessages.push(...stripImagesForSummary(input.history))
  const serializedChars = dataMessages.reduce((sum, message) => sum + JSON.stringify(message).length, 0)
  return [
    {
      role: 'user',
      content: renderUntrustedTranscript({
        purpose: 'compaction',
        messages: dataMessages,
        maxChars: serializedChars + 2_000,
      }),
    },
    { role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION },
  ]
}

export async function maybeCompactConversation(
  context: AgentContext,
  lastInputTokens: number | null,
  options: MaybeCompactOptions = {},
): Promise<boolean> {
  return await compactConversation(context, lastInputTokens, options, false)
}

/** Provider 已拒绝当前 prompt 时强制压缩；调用方负责限制每轮恢复次数。 */
export async function compactConversationForRecovery(
  context: AgentContext,
  options: MaybeCompactOptions = {},
): Promise<boolean> {
  return await compactConversation(context, null, options, true)
}

async function compactConversation(
  context: AgentContext,
  lastInputTokens: number | null,
  options: MaybeCompactOptions,
  force: boolean,
): Promise<boolean> {
  if (lastInputTokens == null && !force) return false

  const summarize = options.summarize ?? defaultSummarize
  const triggerTokens = options.triggerTokens ?? config.compactionTriggerTokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS
  const selectionOptions = options.keepRatio == null && options.tailMaxChars == null
    ? { ...options, tailMaxChars: DEFAULT_COMPACTION_TAIL_CHARS }
    : options

  if (!force && lastInputTokens! <= triggerTokens) return false

  const snapshot = context.getSnapshot()

  log.info(
    { inputTokens: lastInputTokens, messageCount: snapshot.messages.length, triggerTokens, force },
    force ? 'compaction_recovery_triggered' : 'compaction_triggered',
  )

  const cutIndex = selectTailCutIndex(snapshot.messages, selectionOptions)
  if (cutIndex <= 0) {
    log.warn(
      { inputTokens: lastInputTokens, messageCount: snapshot.messages.length },
      'compaction_no_safe_cut',
    )
    return false
  }

  const toCompress = snapshot.messages.slice(0, cutIndex)
  const tail = stripInactiveNativeBlocks(snapshot.messages.slice(cutIndex))
  const { previousSummary, rest: historyToSummarize } = splitExistingSummary(toCompress)

  if (historyToSummarize.length === 0 && !previousSummary) {
    return false
  }

  let rawSummary: string
  try {
    rawSummary = await summarize({
      previousSummary,
      history: stripImagesForSummary(historyToSummarize),
    })
  } catch (err) {
    log.error({ err, inputTokens: lastInputTokens, cutIndex, force }, 'summarizer_failed_context_preserved')
    return false
  }
  const validatedSummary = validateSummary(rawSummary)
  if (!validatedSummary.ok) {
    log.warn({
      inputTokens: lastInputTokens,
      cutIndex,
      tailLen: tail.length,
      reason: validatedSummary.reason,
    }, 'compaction_candidate_summary_rejected')
    return false
  }

  const summaryWithoutRuntimeState = stripRestResumeReminderCompactionSuffix(
    `${SUMMARY_HEAD_PREFIX}${validatedSummary.summary}`,
  )
  const summaryMessage: AgentMessage = {
    role: 'user',
    content: `${summaryWithoutRuntimeState}${renderRestResumeReminderCompactionSuffix(toCompress)}`,
  }
  const candidateMessages = [summaryMessage, ...tail]
  const integrity = validateBotSnapshotIntegrity({
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      messages: candidateMessages,
      activeToolCapabilities: snapshot.activeToolCapabilities,
    },
    mailboxCursors: {},
    goalRevision: 0,
  })
  if (!integrity.ok) {
    log.error({
      inputTokens: lastInputTokens,
      cutIndex,
      errors: integrity.errors,
    }, 'compaction_candidate_integrity_rejected')
    return false
  }

  context.replaceMessages(candidateMessages)

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
  return true
}
