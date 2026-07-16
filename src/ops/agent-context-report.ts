import type {
  AgentMessage,
  ToolResultContent,
} from '../agent/agent-context.types.js'
import {
  buildClaudeCodeRequestBody,
  shouldReplayClaudeNativeBlocks,
  type ClaudeThinkingMode,
  type ClaudeThinkingRetention,
} from '../agent/claude-code/request.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import { buildOpenAIAgentRequest } from '../agent/openai-agent/llm-client.js'
import type { WorkingContextProjection } from '../agent/working-context.js'
import type { AgentContextSurface } from './agent-context-surface.js'

export type AgentContextCategoryName =
  | 'systemIdentity'
  | 'botSystemPrompt'
  | 'visibleTools'
  | 'userAndRuntimeMessages'
  | 'assistantToolCalls'
  | 'assistantThinking'
  | 'toolResultsText'
  | 'workingImages'
  | 'assistantText'

export interface AgentContextReport {
  schemaVersion: 1
  generatedAt: string
  model: string | null
  provider: 'claude-code' | 'openai-agent' | null
  contextWindowTokens: number | null
  estimateMethod: 'local_structure_utf8_bytes'
  estimateComplete: boolean
  estimatedKnownInputTokens: number
  estimatedCurrentInputTokens: number | null
  freeTokens: number | null
  usagePercent: number | null
  compaction: {
    reserveTokens: number
    keepRecentTokens: number
    triggerTokens: number | null
    tokensUntilTrigger: number | null
    overTrigger: boolean | null
  }
  categories: Record<AgentContextCategoryName, {
    available: boolean
    tokens: number | null
    percent: number | null
  }>
  messages: {
    canonical: number
    working: number
    hydratedImages: number
    omittedImages: number
    unavailableImages: number
  }
  toolResultContributors: Array<{
    toolName: string
    tokens: number
    resultCount: number
  }>
  latestProviderUsage: null | {
    ts: string
    model: string
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
  }
  surfaceStatus: 'live' | 'last_startup' | 'missing' | 'invalid'
  warnings: string[]
}

interface MutableContributor {
  tokens: number
  resultCount: number
}

interface ProviderMessageFragment {
  category: AgentContextCategoryName
  weightBytes: number
  toolCallId?: string
}

const unmatchedToolResultName = '<unmatched-tool-result>'

const categoryNames: AgentContextCategoryName[] = [
  'systemIdentity',
  'botSystemPrompt',
  'visibleTools',
  'userAndRuntimeMessages',
  'assistantToolCalls',
  'assistantThinking',
  'toolResultsText',
  'workingImages',
  'assistantText',
]

export function analyzeAgentContext(input: {
  canonicalMessageCount: number
  working: WorkingContextProjection
  surface: AgentContextSurface | null
  surfaceStatus: AgentContextReport['surfaceStatus']
  latestProviderUsage: AgentContextReport['latestProviderUsage']
  reserveTokens: number
  keepRecentTokens: number
  claudeThinkingMode: ClaudeThinkingMode
  claudeThinkingRetention: ClaudeThinkingRetention
  generatedAt: string
  fallbackModel?: string
  fallbackProvider?: 'claude-code' | 'openai-agent'
  fallbackContextWindowTokens?: number
}): AgentContextReport {
  const warnings: string[] = []
  const surface = input.surface
  const surfaceAvailable = surface !== null
  const model = surface !== null
    ? surface.model
    : normalizeModel(input.fallbackModel)
  const provider = surface !== null
    ? surface.provider
    : input.fallbackProvider ?? null
  const contextWindowTokens = surface !== null
    ? normalizeNonNegativeSafeInteger(surface.contextWindowTokens)
    : normalizeOptionalNonNegativeSafeInteger(input.fallbackContextWindowTokens)

  if (!surfaceAvailable) {
    const hasFallback = model !== null || provider !== null || contextWindowTokens !== null
    warnings.push(hasFallback
      ? `Request surface is ${input.surfaceStatus}; fallback metadata does not make the estimate complete.`
      : `Request surface is ${input.surfaceStatus}; fixed input categories are unavailable.`)
  }

  const categoryTokens: Record<AgentContextCategoryName, number | null> = {
    systemIdentity: surface !== null
      ? normalizeNonNegativeSafeInteger(surface.systemIdentity.tokens)
      : null,
    botSystemPrompt: surface !== null
      ? normalizeNonNegativeSafeInteger(surface.botSystemPrompt.tokens)
      : null,
    visibleTools: surface !== null
      ? normalizeNonNegativeSafeInteger(surface.tools.totalTokens)
      : null,
    userAndRuntimeMessages: 0,
    assistantToolCalls: 0,
    assistantThinking: 0,
    toolResultsText: 0,
    workingImages: 0,
    assistantText: 0,
  }

  const toolNamesByCallId = collectToolCallNames(input.working.messages)
  const {
    contributors,
    unknownToolResults,
  } = initializeToolResultContributors(input.working.messages, toolNamesByCallId)

  if (provider === null) {
    warnings.push('Provider unavailable; using generic raw message estimation.')
    measureGenericMessages({
      messages: input.working.messages,
      thinkingMode: input.claudeThinkingMode,
      thinkingRetention: input.claudeThinkingRetention,
      categoryTokens,
      contributors,
      toolNamesByCallId,
    })
  } else {
    const providerProjection = buildProviderMessageProjection({
      provider,
      model: model ?? '',
      messages: input.working.messages,
      thinkingMode: input.claudeThinkingMode,
      thinkingRetention: input.claudeThinkingRetention,
    })
    applyProviderMessageEstimate({
      ...providerProjection,
      categoryTokens,
      contributors,
      toolNamesByCallId,
    })
  }

  if (unknownToolResults > 0) {
    warnings.push(
      `Found ${unknownToolResults} unknown tool result(s) without a matching assistant tool call.`,
    )
  }

  const estimatedKnownInputTokens = categoryNames.reduce((sum, name) => {
    const tokens = categoryTokens[name]
    return tokens === null ? sum : safeAdd(sum, tokens)
  }, 0)
  const estimateComplete = surfaceAvailable
  const estimatedCurrentInputTokens = estimateComplete ? estimatedKnownInputTokens : null
  const reserveTokens = normalizeNonNegativeSafeInteger(input.reserveTokens)
  const keepRecentTokens = normalizeNonNegativeSafeInteger(input.keepRecentTokens)
  const triggerTokens = contextWindowTokens === null
    ? null
    : safeSubtract(contextWindowTokens, reserveTokens)
  const tokensUntilTrigger = triggerTokens === null || estimatedCurrentInputTokens === null
    ? null
    : safeSubtract(triggerTokens, estimatedCurrentInputTokens)
  const overTrigger = triggerTokens === null || estimatedCurrentInputTokens === null
    ? null
    : estimatedCurrentInputTokens > triggerTokens
  const freeTokens = contextWindowTokens === null || estimatedCurrentInputTokens === null
    ? null
    : safeSubtract(contextWindowTokens, estimatedCurrentInputTokens)
  const usagePercent = contextWindowTokens === null || estimatedCurrentInputTokens === null
    ? null
    : percentage(estimatedCurrentInputTokens, contextWindowTokens)

  const categories = Object.fromEntries(categoryNames.map((name) => {
    const tokens = categoryTokens[name]
    return [name, {
      available: tokens !== null,
      tokens,
      percent: tokens === null || contextWindowTokens === null
        ? null
        : percentage(tokens, contextWindowTokens),
    }]
  })) as AgentContextReport['categories']

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    model,
    provider,
    contextWindowTokens,
    estimateMethod: 'local_structure_utf8_bytes',
    estimateComplete,
    estimatedKnownInputTokens,
    estimatedCurrentInputTokens,
    freeTokens,
    usagePercent,
    compaction: {
      reserveTokens,
      keepRecentTokens,
      triggerTokens,
      tokensUntilTrigger,
      overTrigger,
    },
    categories,
    messages: {
      canonical: normalizeNonNegativeSafeInteger(input.canonicalMessageCount),
      working: normalizeNonNegativeSafeInteger(input.working.messages.length),
      hydratedImages: normalizeNonNegativeSafeInteger(input.working.stats.hydratedImages),
      omittedImages: normalizeNonNegativeSafeInteger(input.working.stats.omittedImages),
      unavailableImages: normalizeNonNegativeSafeInteger(input.working.stats.unavailableImages),
    },
    toolResultContributors: [...contributors.entries()]
      .map(([toolName, contributor]) => ({ toolName, ...contributor }))
      .sort((left, right) => (
        right.tokens - left.tokens || compareStrings(left.toolName, right.toolName)
      )),
    latestProviderUsage: input.latestProviderUsage,
    surfaceStatus: input.surfaceStatus,
    warnings,
  }
}

function collectToolCallNames(messages: readonly AgentMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls) names.set(call.id, call.name)
  }
  return names
}

function initializeToolResultContributors(
  messages: readonly AgentMessage[],
  toolNamesByCallId: ReadonlyMap<string, string>,
): { contributors: Map<string, MutableContributor>; unknownToolResults: number } {
  const contributors = new Map<string, MutableContributor>()
  let unknownToolResults = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const toolName = contributorName(message.toolCallId, toolNamesByCallId)
    if (toolName === unmatchedToolResultName) unknownToolResults++
    const contributor = contributors.get(toolName) ?? { tokens: 0, resultCount: 0 }
    contributor.resultCount = safeAdd(contributor.resultCount, 1)
    contributors.set(toolName, contributor)
  }
  return { contributors, unknownToolResults }
}

function buildProviderMessageProjection(input: {
  provider: NonNullable<AgentContextReport['provider']>
  model: string
  messages: AgentMessage[]
  thinkingMode: ClaudeThinkingMode
  thinkingRetention: ClaudeThinkingRetention
}): { providerMessages: unknown[]; fragments: ProviderMessageFragment[] } {
  if (input.provider === 'claude-code') {
    const providerMessages = buildClaudeCodeRequestBody({
      model: input.model,
      systemPrompt: '',
      messages: input.messages,
      tools: [],
      thinking: {
        mode: input.thinkingMode,
        retention: input.thinkingRetention,
      },
    }).messages
    return {
      providerMessages,
      fragments: classifyClaudeMessageFragments(providerMessages),
    }
  }

  const providerMessages = buildOpenAIAgentRequest({
    model: input.model,
    systemPrompt: '',
    messages: input.messages,
    tools: [],
  }).messages.slice(1)
  return {
    providerMessages,
    fragments: classifyOpenAIMessageFragments(providerMessages),
  }
}

function classifyClaudeMessageFragments(providerMessages: readonly unknown[]): ProviderMessageFragment[] {
  const fragments: ProviderMessageFragment[] = []
  for (const value of providerMessages) {
    if (!isRecord(value) || !Array.isArray(value.content)) continue
    if (value.role === 'assistant') {
      for (const block of value.content) {
        if (!isRecord(block)) continue
        const category = block.type === 'tool_use'
          ? 'assistantToolCalls'
          : block.type === 'thinking' || block.type === 'redacted_thinking'
            ? 'assistantThinking'
            : 'assistantText'
        addProviderFragment(fragments, category, block)
      }
      continue
    }

    for (const block of value.content) {
      if (!isRecord(block)) continue
      if (block.type !== 'tool_result') {
        addProviderFragment(fragments, 'userAndRuntimeMessages', block)
        continue
      }
      const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const { content, ...wrapper } = block
      addProviderFragment(fragments, 'toolResultsText', wrapper, toolCallId)
      if (Array.isArray(content)) {
        for (const resultBlock of content) {
          addProviderFragment(
            fragments,
            isRecord(resultBlock) && resultBlock.type === 'image'
              ? 'workingImages'
              : 'toolResultsText',
            resultBlock,
            toolCallId,
          )
        }
      } else {
        addProviderFragment(fragments, 'toolResultsText', content, toolCallId)
      }
    }
  }
  return fragments
}

function classifyOpenAIMessageFragments(providerMessages: readonly unknown[]): ProviderMessageFragment[] {
  const fragments: ProviderMessageFragment[] = []
  let pendingImageToolCallId: string | undefined
  for (const value of providerMessages) {
    if (!isRecord(value)) continue
    if (value.role === 'tool') {
      pendingImageToolCallId = typeof value.tool_call_id === 'string'
        ? value.tool_call_id
        : undefined
      addProviderFragment(fragments, 'toolResultsText', value, pendingImageToolCallId)
      continue
    }
    if (value.role === 'assistant') {
      pendingImageToolCallId = undefined
      const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : []
      if (value.content !== null && (value.content !== '' || toolCalls.length === 0)) {
        addProviderFragment(fragments, 'assistantText', { content: value.content })
      }
      for (const toolCall of toolCalls) {
        addProviderFragment(fragments, 'assistantToolCalls', toolCall)
      }
      continue
    }
    if (value.role === 'user' && Array.isArray(value.content)) {
      const toolCallId = pendingImageToolCallId
      for (const part of value.content) {
        addProviderFragment(
          fragments,
          isRecord(part) && part.type === 'image_url'
            ? 'workingImages'
            : toolCallId === undefined
              ? 'userAndRuntimeMessages'
              : 'toolResultsText',
          part,
          toolCallId,
        )
      }
      pendingImageToolCallId = undefined
      continue
    }
    pendingImageToolCallId = undefined
    addProviderFragment(fragments, 'userAndRuntimeMessages', value)
  }
  return fragments
}

function addProviderFragment(
  fragments: ProviderMessageFragment[],
  category: AgentContextCategoryName,
  value: unknown,
  toolCallId?: string,
): void {
  fragments.push({
    category,
    weightBytes: Buffer.byteLength(stableStringify(value), 'utf8'),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  })
}

function applyProviderMessageEstimate(input: {
  providerMessages: unknown[]
  fragments: ProviderMessageFragment[]
  categoryTokens: Record<AgentContextCategoryName, number | null>
  contributors: Map<string, MutableContributor>
  toolNamesByCallId: ReadonlyMap<string, string>
}): void {
  if (input.providerMessages.length === 0) return
  const totalTokens = estimateStructure(input.providerMessages)
  if (input.fragments.length === 0) {
    input.categoryTokens.userAndRuntimeMessages = safeAdd(
      input.categoryTokens.userAndRuntimeMessages ?? 0,
      totalTokens,
    )
    return
  }

  const totalWeight = input.fragments.reduce(
    (sum, fragment) => sum + BigInt(fragment.weightBytes),
    0n,
  )
  const allocations = input.fragments.map((fragment, index) => {
    const numerator = BigInt(totalTokens) * BigInt(fragment.weightBytes)
    return {
      fragment,
      index,
      tokens: Number(numerator / totalWeight),
      remainder: numerator % totalWeight,
    }
  })
  const assignedTokens = allocations.reduce((sum, allocation) => (
    sum + BigInt(allocation.tokens)
  ), 0n)
  const tokensLeft = Number(BigInt(totalTokens) - assignedTokens)
  const byRemainder = [...allocations].sort((left, right) => (
    left.remainder === right.remainder
      ? left.index - right.index
      : left.remainder > right.remainder ? -1 : 1
  ))
  for (let index = 0; index < tokensLeft; index++) {
    const allocation = byRemainder[index]
    if (allocation) allocation.tokens++
  }

  for (const { fragment, tokens } of allocations) {
    input.categoryTokens[fragment.category] = safeAdd(
      input.categoryTokens[fragment.category] ?? 0,
      tokens,
    )
    if (fragment.toolCallId === undefined) continue
    const toolName = contributorName(fragment.toolCallId, input.toolNamesByCallId)
    const contributor = input.contributors.get(toolName)
    if (contributor) contributor.tokens = safeAdd(contributor.tokens, tokens)
  }
}

function measureGenericMessages(input: {
  messages: AgentMessage[]
  thinkingMode: ClaudeThinkingMode
  thinkingRetention: ClaudeThinkingRetention
  categoryTokens: Record<AgentContextCategoryName, number | null>
  contributors: Map<string, MutableContributor>
  toolNamesByCallId: ReadonlyMap<string, string>
}): void {
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index]!
    if (message.role === 'user') {
      input.categoryTokens.userAndRuntimeMessages = safeAdd(
        input.categoryTokens.userAndRuntimeMessages ?? 0,
        estimateStructure({ role: 'user', content: message.content }),
      )
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        input.categoryTokens.assistantText = safeAdd(
          input.categoryTokens.assistantText ?? 0,
          estimateStructure({ role: 'assistant', content: message.content }),
        )
      }
      if (message.toolCalls.length > 0) {
        input.categoryTokens.assistantToolCalls = safeAdd(
          input.categoryTokens.assistantToolCalls ?? 0,
          estimateStructure(message.toolCalls),
        )
      }
      if (
        input.thinkingMode === 'adaptive'
        && message.nativeBlocks
        && message.nativeBlocks.length > 0
        && shouldReplayClaudeNativeBlocks(input.messages, index, input.thinkingRetention)
      ) {
        input.categoryTokens.assistantThinking = safeAdd(
          input.categoryTokens.assistantThinking ?? 0,
          estimateStructure(message.nativeBlocks),
        )
      }
      continue
    }

    const resultTokens = measureGenericToolResult(message.content, input.categoryTokens)
    const toolName = contributorName(message.toolCallId, input.toolNamesByCallId)
    const contributor = input.contributors.get(toolName)
    if (contributor) contributor.tokens = safeAdd(contributor.tokens, resultTokens)
  }
}

function measureGenericToolResult(
  content: ToolResultContent,
  categoryTokens: Record<AgentContextCategoryName, number | null>,
): number {
  if (typeof content === 'string') {
    const tokens = estimateStructure(content)
    categoryTokens.toolResultsText = safeAdd(categoryTokens.toolResultsText ?? 0, tokens)
    return tokens
  }

  let total = 0
  for (const block of content) {
    const tokens = estimateStructure(block)
    total = safeAdd(total, tokens)
    if (block.type === 'image') {
      categoryTokens.workingImages = safeAdd(categoryTokens.workingImages ?? 0, tokens)
    } else {
      categoryTokens.toolResultsText = safeAdd(categoryTokens.toolResultsText ?? 0, tokens)
    }
  }
  return total
}

function contributorName(
  toolCallId: string,
  toolNamesByCallId: ReadonlyMap<string, string>,
): string {
  return toolNamesByCallId.get(toolCallId) ?? unmatchedToolResultName
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function estimateStructure(value: unknown): number {
  return estimateUtf8Tokens(stableStringify(value))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined && typeof child !== 'function' && typeof child !== 'symbol')
    .sort(([left], [right]) => compareStrings(left, right))
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(',')}}`
}

function normalizeModel(model: string | undefined): string | null {
  return model && model.length > 0 ? model : null
}

function normalizeOptionalNonNegativeSafeInteger(value: number | undefined): number | null {
  return value === undefined ? null : normalizeNonNegativeSafeInteger(value)
}

function normalizeNonNegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  return Math.floor(value)
}

function safeAdd(left: number, right: number): number {
  const total = left + right
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER
}

function safeSubtract(left: number, right: number): number {
  return Math.max(0, left - right)
}

function percentage(value: number, total: number): number {
  if (total === 0) return 0
  return Math.min(100, Math.max(0, Math.round(value / total * 1_000) / 10))
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
