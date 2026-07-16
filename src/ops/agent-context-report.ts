import type {
  AgentMessage,
  ToolResultContent,
} from '../agent/agent-context.types.js'
import {
  shouldReplayClaudeNativeBlocks,
  type ClaudeThinkingMode,
  type ClaudeThinkingRetention,
} from '../agent/claude-code/request.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
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
  const contributors = new Map<string, MutableContributor>()
  let unknownToolResults = 0

  for (let index = 0; index < input.working.messages.length; index++) {
    const message = input.working.messages[index]!
    if (message.role === 'user') {
      categoryTokens.userAndRuntimeMessages = safeAdd(
        categoryTokens.userAndRuntimeMessages ?? 0,
        estimateStructure({ role: 'user', content: message.content }),
      )
      continue
    }

    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        categoryTokens.assistantText = safeAdd(
          categoryTokens.assistantText ?? 0,
          estimateStructure({ role: 'assistant', content: message.content }),
        )
      }
      if (message.toolCalls.length > 0) {
        categoryTokens.assistantToolCalls = safeAdd(
          categoryTokens.assistantToolCalls ?? 0,
          estimateStructure(message.toolCalls),
        )
      }
      if (
        provider === 'claude-code'
        && input.claudeThinkingMode === 'adaptive'
        && message.nativeBlocks
        && message.nativeBlocks.length > 0
        && shouldReplayClaudeNativeBlocks(
          input.working.messages,
          index,
          input.claudeThinkingRetention,
        )
      ) {
        categoryTokens.assistantThinking = safeAdd(
          categoryTokens.assistantThinking ?? 0,
          estimateStructure(message.nativeBlocks),
        )
      }
      continue
    }

    const resultTokens = measureToolResult(message.content, categoryTokens)
    const mappedToolName = toolNamesByCallId.get(message.toolCallId)
    const toolName = mappedToolName ?? 'unknown'
    if (mappedToolName === undefined) unknownToolResults++
    const contributor = contributors.get(toolName) ?? { tokens: 0, resultCount: 0 }
    contributor.tokens = safeAdd(contributor.tokens, resultTokens)
    contributor.resultCount = safeAdd(contributor.resultCount, 1)
    contributors.set(toolName, contributor)
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
    : estimatedCurrentInputTokens >= triggerTokens
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

function measureToolResult(
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
