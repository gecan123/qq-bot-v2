import type { AgentMessage, ToolResultContent } from '../agent/agent-context.types.js'
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
  schemaVersion: 2
  generatedAt: string
  model: string | null
  provider: 'claude-code' | 'openai-agent' | null
  contextWindowTokens: number | null
  estimatedSnapshotTokens: number | null
  freeTokens: number | null
  usagePercent: number | null
  compaction: {
    reserveTokens: number
    keepRecentTokens: number
    triggerTokens: number | null
    tokensUntilTrigger: number | null
  }
  categories: Record<AgentContextCategoryName, number | null>
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
  surfaceStatus: 'available' | 'missing' | 'invalid'
  warnings: string[]
}

interface MutableContributor {
  tokens: number
  resultCount: number
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
  const surface = input.surface
  const model = surface?.model ?? normalizeModel(input.fallbackModel)
  const provider = surface?.provider ?? input.fallbackProvider ?? null
  const contextWindowTokens = surface === null
    ? normalizeOptionalNonNegativeSafeInteger(input.fallbackContextWindowTokens)
    : normalizeNonNegativeSafeInteger(surface.contextWindowTokens)
  const warnings: string[] = []
  if (surface === null) {
    warnings.push(`Request surface is ${input.surfaceStatus}; fixed input categories are unavailable.`)
  }

  const categories: Record<AgentContextCategoryName, number | null> = {
    systemIdentity: surface?.fixedTokens.systemIdentity ?? null,
    botSystemPrompt: surface?.fixedTokens.botSystemPrompt ?? null,
    visibleTools: surface?.fixedTokens.visibleTools ?? null,
    userAndRuntimeMessages: 0,
    assistantToolCalls: 0,
    assistantThinking: 0,
    toolResultsText: 0,
    workingImages: 0,
    assistantText: 0,
  }
  const toolNamesByCallId = new Map<string, string>()
  const contributors = new Map<string, MutableContributor>()
  let unknownToolResults = 0

  for (let index = 0; index < input.working.messages.length; index++) {
    const message = input.working.messages[index]!
    if (message.role === 'user') {
      addCategory(categories, 'userAndRuntimeMessages', estimateStructure({
        role: 'user',
        content: message.content,
      }))
      continue
    }

    if (message.role === 'assistant') {
      for (const call of message.toolCalls) toolNamesByCallId.set(call.id, call.name)
      if (message.content.length > 0) {
        addCategory(categories, 'assistantText', estimateStructure({
          role: 'assistant',
          content: message.content,
        }))
      }
      if (message.toolCalls.length > 0) {
        addCategory(categories, 'assistantToolCalls', estimateStructure(message.toolCalls))
      }
      if (
        provider === 'claude-code'
        && input.claudeThinkingMode === 'adaptive'
        && shouldReplayClaudeNativeBlocks(
          input.working.messages,
          index,
          input.claudeThinkingRetention,
        )
      ) {
        addCategory(categories, 'assistantThinking', estimateStructure(message.nativeBlocks))
      }
      continue
    }

    const resultTokens = measureToolResult(message.content, categories)
    const toolName = toolNamesByCallId.get(message.toolCallId) ?? unmatchedToolResultName
    if (toolName === unmatchedToolResultName) unknownToolResults++
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

  const estimatedSnapshotTokens = surface === null
    ? null
    : categoryNames.reduce((sum, name) => safeAdd(sum, categories[name] ?? 0), 0)
  const reserveTokens = normalizeNonNegativeSafeInteger(input.reserveTokens)
  const keepRecentTokens = normalizeNonNegativeSafeInteger(input.keepRecentTokens)
  const triggerTokens = contextWindowTokens === null
    ? null
    : safeSubtract(contextWindowTokens, reserveTokens)
  const tokensUntilTrigger = triggerTokens === null || estimatedSnapshotTokens === null
    ? null
    : safeSubtract(triggerTokens, estimatedSnapshotTokens)
  const freeTokens = contextWindowTokens === null || estimatedSnapshotTokens === null
    ? null
    : safeSubtract(contextWindowTokens, estimatedSnapshotTokens)
  const usagePercent = contextWindowTokens === null || estimatedSnapshotTokens === null
    ? null
    : percentage(estimatedSnapshotTokens, contextWindowTokens)

  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    model,
    provider,
    contextWindowTokens,
    estimatedSnapshotTokens,
    freeTokens,
    usagePercent,
    compaction: { reserveTokens, keepRecentTokens, triggerTokens, tokensUntilTrigger },
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

function measureToolResult(
  content: ToolResultContent,
  categories: Record<AgentContextCategoryName, number | null>,
): number {
  if (typeof content === 'string') {
    const tokens = estimateStructure(content)
    addCategory(categories, 'toolResultsText', tokens)
    return tokens
  }

  let total = 0
  for (const block of content) {
    const tokens = estimateStructure(block)
    total = safeAdd(total, tokens)
    addCategory(categories, block.type === 'image' ? 'workingImages' : 'toolResultsText', tokens)
  }
  return total
}

function addCategory(
  categories: Record<AgentContextCategoryName, number | null>,
  name: AgentContextCategoryName,
  tokens: number,
): void {
  categories[name] = safeAdd(categories[name] ?? 0, tokens)
}

function estimateStructure(value: unknown): number {
  return estimateUtf8Tokens(JSON.stringify(value) ?? 'null')
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
