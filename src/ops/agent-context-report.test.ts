import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from '../agent/agent-context.types.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import type { WorkingContextProjection } from '../agent/working-context.js'
import type { AgentContextSurface } from './agent-context-surface.js'
import { analyzeAgentContext, type AgentContextReport } from './agent-context-report.js'

const generatedAt = '2026-07-16T12:00:00.000+08:00'
const messages: AgentMessage[] = [
  { role: 'user', content: 'runtime notice' },
  {
    role: 'assistant',
    content: 'assistant reply',
    toolCalls: [{ id: 'call-1', name: 'inbox', args: { action: 'read' } }],
    nativeBlocks: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }],
  },
  {
    role: 'tool',
    toolCallId: 'call-1',
    content: [
      { type: 'text', text: 'tool text' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  },
]
const working: WorkingContextProjection = {
  messages,
  stats: {
    sourceMessages: 5,
    projectedMessages: 3,
    hydratedImages: 2,
    omittedImages: 1,
    unavailableImages: 4,
  },
}
const surface: AgentContextSurface = {
  schemaVersion: 2,
  generatedAt,
  provider: 'claude-code',
  model: 'claude-opus-4-7',
  contextWindowTokens: 1_000,
  fixedTokens: { systemIdentity: 10, botSystemPrompt: 20, visibleTools: 30 },
}
const latestProviderUsage: NonNullable<AgentContextReport['latestProviderUsage']> = {
  ts: '2026-07-16T11:59:00.000+08:00',
  model: 'provider-observed-model',
  inputTokens: 777,
  cachedTokens: 666,
  outputTokens: 55,
}

function estimate(value: unknown): number {
  return estimateUtf8Tokens(JSON.stringify(value) ?? 'null')
}

function analyze(overrides: Partial<Parameters<typeof analyzeAgentContext>[0]> = {}) {
  return analyzeAgentContext({
    canonicalMessageCount: 5,
    working,
    surface,
    surfaceStatus: 'available',
    latestProviderUsage,
    reserveTokens: 100,
    keepRecentTokens: 50,
    claudeThinkingMode: 'adaptive',
    claudeThinkingRetention: 'always',
    generatedAt,
    ...overrides,
  })
}

describe('analyzeAgentContext', () => {
  test('builds schema v2 with direct, mutually exclusive category values', () => {
    const report = analyze()
    const assistant = messages[1]!
    const tool = messages[2]!
    assert.equal(assistant.role, 'assistant')
    assert.equal(tool.role, 'tool')

    assert.equal(report.schemaVersion, 2)
    assert.equal(report.categories.systemIdentity, 10)
    assert.equal(report.categories.botSystemPrompt, 20)
    assert.equal(report.categories.visibleTools, 30)
    assert.equal(
      report.categories.userAndRuntimeMessages,
      estimate({ role: 'user', content: 'runtime notice' }),
    )
    assert.equal(
      report.categories.assistantText,
      estimate({ role: 'assistant', content: assistant.content }),
    )
    assert.equal(report.categories.assistantToolCalls, estimate(assistant.toolCalls))
    assert.equal(report.categories.assistantThinking, estimate(assistant.nativeBlocks))
    assert.equal(report.categories.toolResultsText, estimate(tool.content[0]))
    assert.equal(report.categories.workingImages, estimate(tool.content[1]))

    const categoryTotal = Object.values(report.categories).reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    )
    assert.equal(report.estimatedSnapshotTokens, categoryTotal)
    assert.equal('estimatedCurrentInputTokens' in report, false)
    assert.equal('estimatedKnownInputTokens' in report, false)
    assert.equal('estimateComplete' in report, false)
    assert.equal('overTrigger' in report.compaction, false)
  })

  test('keeps provider usage separate and computes window/headroom values', () => {
    const report = analyze()
    const estimated = report.estimatedSnapshotTokens!

    assert.deepEqual(report.latestProviderUsage, latestProviderUsage)
    assert.notEqual(estimated, latestProviderUsage.inputTokens)
    assert.equal(report.freeTokens, Math.max(0, 1_000 - estimated))
    assert.equal(report.usagePercent, Math.min(100, Math.round(estimated / 1_000 * 1_000) / 10))
    assert.deepEqual(report.compaction, {
      reserveTokens: 100,
      keepRecentTokens: 50,
      triggerTokens: 900,
      tokensUntilTrigger: Math.max(0, 900 - estimated),
    })
  })

  test('counts Claude thinking only when provider, mode, and retention allow replay', () => {
    const closedCycle = {
      ...working,
      messages: [...messages, { role: 'user', content: 'cycle closed' } as const],
    }
    assert.equal(analyze({ working: closedCycle, claudeThinkingRetention: 'active-tool-cycle' })
      .categories.assistantThinking, 0)
    assert.ok(analyze({ working: closedCycle, claudeThinkingRetention: 'always' })
      .categories.assistantThinking! > 0)
    assert.equal(analyze({ claudeThinkingMode: 'disabled' }).categories.assistantThinking, 0)
    assert.equal(analyze({ surface: { ...surface, provider: 'openai-agent' } })
      .categories.assistantThinking, 0)
  })

  test('maps tool results to contributors and keeps unmatched results separate', () => {
    const contributorWorking: WorkingContextProjection = {
      messages: [
        {
          role: 'assistant', content: '', toolCalls: [
            { id: 'one', name: 'zeta', args: {} },
            { id: 'two', name: 'alpha', args: {} },
          ],
        },
        { role: 'tool', toolCallId: 'one', content: 'same' },
        { role: 'tool', toolCallId: 'two', content: 'same' },
        { role: 'tool', toolCallId: 'missing', content: 'a much longer unknown result' },
      ],
      stats: {
        sourceMessages: 4, projectedMessages: 4, hydratedImages: 0,
        omittedImages: 0, unavailableImages: 0,
      },
    }
    const report = analyze({ working: contributorWorking })

    assert.equal(report.toolResultContributors[0]?.toolName, '<unmatched-tool-result>')
    assert.equal(report.toolResultContributors[0]?.resultCount, 1)
    assert.deepEqual(
      new Set(report.toolResultContributors.slice(1).map((item) => item.toolName)),
      new Set(['alpha', 'zeta']),
    )
    assert.ok(report.warnings.some((warning) => /unknown tool result/i.test(warning)))
    assert.equal(JSON.stringify(report).includes('much longer unknown result'), false)
  })

  test('reports projection counts verbatim', () => {
    assert.deepEqual(analyze({ canonicalMessageCount: 42 }).messages, {
      canonical: 42,
      working: 3,
      hydratedImages: 2,
      omittedImages: 1,
      unavailableImages: 4,
    })
  })

  test('keeps message categories but marks the total unavailable without a surface', () => {
    const report = analyze({
      surface: null,
      surfaceStatus: 'missing',
      fallbackModel: 'fallback-model',
      fallbackProvider: 'openai-agent',
      fallbackContextWindowTokens: 2_000,
    })

    assert.equal(report.categories.systemIdentity, null)
    assert.equal(report.categories.botSystemPrompt, null)
    assert.equal(report.categories.visibleTools, null)
    assert.ok(report.categories.userAndRuntimeMessages! > 0)
    assert.equal(report.estimatedSnapshotTokens, null)
    assert.equal(report.freeTokens, null)
    assert.equal(report.usagePercent, null)
    assert.equal(report.model, 'fallback-model')
    assert.equal(report.provider, 'openai-agent')
    assert.equal(report.contextWindowTokens, 2_000)
    assert.ok(report.warnings.some((warning) => /missing/i.test(warning)))
  })
})
