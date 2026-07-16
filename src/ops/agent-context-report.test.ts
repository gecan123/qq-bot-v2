import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from '../agent/agent-context.types.js'
import { estimateUtf8Tokens } from '../agent/compaction-token-estimator.js'
import type { WorkingContextProjection } from '../agent/working-context.js'
import type { AgentContextSurface } from './agent-context-surface.js'
import {
  analyzeAgentContext,
  type AgentContextCategoryName,
  type AgentContextReport,
} from './agent-context-report.js'

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
  schemaVersion: 1,
  generatedAt,
  pid: 123,
  provider: 'claude-code',
  model: 'claude-opus-4-7',
  contextWindowTokens: 1_000,
  systemIdentity: { bytes: 40, tokens: 10 },
  botSystemPrompt: { bytes: 80, tokens: 20 },
  tools: {
    totalBytes: 120,
    totalTokens: 30,
    items: [{ name: 'inbox', bytes: 120, tokens: 30 }],
  },
  fingerprint: 'a'.repeat(64),
}

const latestProviderUsage: NonNullable<AgentContextReport['latestProviderUsage']> = {
  ts: '2026-07-16T11:59:00.000+08:00',
  model: 'provider-observed-model',
  inputTokens: 777,
  cachedTokens: 666,
  outputTokens: 55,
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`
}

function tokens(value: unknown): number {
  return estimateUtf8Tokens(stableJson(value))
}

function analyze(overrides: Partial<Parameters<typeof analyzeAgentContext>[0]> = {}) {
  return analyzeAgentContext({
    canonicalMessageCount: 5,
    working,
    surface,
    surfaceStatus: 'live',
    latestProviderUsage,
    reserveTokens: 100,
    keepRecentTokens: 50,
    claudeThinkingMode: 'adaptive',
    claudeThinkingRetention: 'always',
    generatedAt,
    ...overrides,
  })
}

describe('analyzeAgentContext categories', () => {
  test('reports complete mutually exclusive surface and message categories', () => {
    const report = analyze()
    const expected: Record<AgentContextCategoryName, number> = {
      systemIdentity: 10,
      botSystemPrompt: 20,
      visibleTools: 30,
      userAndRuntimeMessages: tokens({ role: 'user', content: 'runtime notice' }),
      assistantToolCalls: tokens(messages[1]?.role === 'assistant' ? messages[1].toolCalls : []),
      assistantThinking: tokens(messages[1]?.role === 'assistant' ? messages[1].nativeBlocks : []),
      toolResultsText: tokens({ type: 'text', text: 'tool text' }),
      workingImages: tokens({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      }),
      assistantText: tokens({ role: 'assistant', content: 'assistant reply' }),
    }

    for (const [name, expectedTokens] of Object.entries(expected)) {
      assert.deepEqual(report.categories[name as AgentContextCategoryName], {
        available: true,
        tokens: expectedTokens,
        percent: Math.round(expectedTokens / 1_000 * 1_000) / 10,
      })
      assert.ok(expectedTokens >= 0)
    }
    assert.equal(
      report.estimatedKnownInputTokens,
      Object.values(report.categories).reduce((sum, category) => sum + (category.tokens ?? 0), 0),
    )
    assert.equal(report.estimatedCurrentInputTokens, report.estimatedKnownInputTokens)
    assert.equal(report.estimateComplete, true)
  })

  test('keeps provider usage separate from the local estimate', () => {
    const report = analyze()

    assert.deepEqual(report.latestProviderUsage, latestProviderUsage)
    assert.notEqual(report.estimatedCurrentInputTokens, latestProviderUsage.inputTokens)
  })

  test('counts Claude thinking only when adaptive and replay-eligible, never for OpenAI', () => {
    const closedCycle = analyze({
      working: {
        ...working,
        messages: [...messages, { role: 'user', content: 'cycle closed' }],
        stats: { ...working.stats, projectedMessages: 4 },
      },
      claudeThinkingRetention: 'active-tool-cycle',
    })
    const always = analyze({
      working: {
        ...working,
        messages: [...messages, { role: 'user', content: 'cycle closed' }],
        stats: { ...working.stats, projectedMessages: 4 },
      },
      claudeThinkingRetention: 'always',
    })
    const disabled = analyze({ claudeThinkingMode: 'disabled' })
    const openai = analyze({ surface: { ...surface, provider: 'openai-agent' } })

    assert.equal(closedCycle.categories.assistantThinking.tokens, 0)
    assert.equal(always.categories.assistantThinking.tokens, tokens(
      messages[1]?.role === 'assistant' ? messages[1].nativeBlocks : [],
    ))
    assert.equal(disabled.categories.assistantThinking.tokens, 0)
    assert.equal(openai.categories.assistantThinking.tokens, 0)
  })
})

describe('analyzeAgentContext window and provenance', () => {
  test('reports window usage, free tokens, and compaction headroom', () => {
    const report = analyze()
    const estimated = report.estimatedCurrentInputTokens!

    assert.equal(report.contextWindowTokens, 1_000)
    assert.equal(report.freeTokens, Math.max(0, 1_000 - estimated))
    assert.equal(report.usagePercent, Math.round(estimated / 1_000 * 1_000) / 10)
    assert.deepEqual(report.compaction, {
      reserveTokens: 100,
      keepRecentTokens: 50,
      triggerTokens: 900,
      tokensUntilTrigger: Math.max(0, 900 - estimated),
      overTrigger: estimated >= 900,
    })
  })

  test('clamps trigger and token headroom at zero when estimate is over the window', () => {
    const report = analyze({
      surface: { ...surface, contextWindowTokens: 50 },
      reserveTokens: 500,
    })

    assert.equal(report.compaction.triggerTokens, 0)
    assert.equal(report.compaction.tokensUntilTrigger, 0)
    assert.equal(report.compaction.overTrigger, true)
    assert.equal(report.freeTokens, 0)
    assert.equal(report.usagePercent, 100)
  })

  test('maps tool result contributors and sorts by tokens then name', () => {
    const contributorWorking: WorkingContextProjection = {
      messages: [
        {
          role: 'assistant', content: '', nativeBlocks: [], toolCalls: [
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

    assert.deepEqual(report.toolResultContributors.map((item) => item.toolName), [
      'unknown', 'alpha', 'zeta',
    ])
    assert.equal(report.toolResultContributors[0]?.resultCount, 1)
    assert.equal(report.toolResultContributors[1]?.tokens, report.toolResultContributors[2]?.tokens)
    assert.ok(report.warnings.some((warning) => /unknown tool result/i.test(warning)))
    assert.equal(JSON.stringify(report).includes('much longer unknown result'), false)
  })

  test('does not treat a tool literally named unknown as an orphan result', () => {
    const report = analyze({
      working: {
        messages: [
          {
            role: 'assistant', content: '', nativeBlocks: [],
            toolCalls: [{ id: 'known', name: 'unknown', args: {} }],
          },
          { role: 'tool', toolCallId: 'known', content: 'known result' },
        ],
        stats: {
          sourceMessages: 2, projectedMessages: 2, hydratedImages: 0,
          omittedImages: 0, unavailableImages: 0,
        },
      },
    })

    assert.deepEqual(report.toolResultContributors.map((item) => item.toolName), ['unknown'])
    assert.equal(report.warnings.some((warning) => /unknown tool result/i.test(warning)), false)
  })

  test('reports canonical, working, and working image projection counts verbatim', () => {
    const report = analyze({ canonicalMessageCount: 42 })

    assert.deepEqual(report.messages, {
      canonical: 42,
      working: 3,
      hydratedImages: 2,
      omittedImages: 1,
      unavailableImages: 4,
    })
  })
})

describe('analyzeAgentContext degraded inputs', () => {
  test('keeps message estimates but marks fixed categories unavailable without a surface', () => {
    const report = analyze({
      surface: null,
      surfaceStatus: 'missing',
      fallbackModel: 'fallback-model',
      fallbackProvider: 'openai-agent',
      fallbackContextWindowTokens: 2_000,
    })

    for (const name of ['systemIdentity', 'botSystemPrompt', 'visibleTools'] as const) {
      assert.deepEqual(report.categories[name], { available: false, tokens: null, percent: null })
    }
    assert.ok(report.categories.userAndRuntimeMessages.tokens! > 0)
    assert.equal(report.estimateComplete, false)
    assert.equal(report.estimatedCurrentInputTokens, null)
    assert.equal(report.freeTokens, null)
    assert.equal(report.usagePercent, null)
    assert.equal(report.model, 'fallback-model')
    assert.equal(report.provider, 'openai-agent')
    assert.equal(report.contextWindowTokens, 2_000)
    assert.ok(report.warnings.some((warning) => /fallback/i.test(warning)))
  })

  test('normalizes unsafe counts and arithmetic without producing negative or unsafe values', () => {
    const report = analyze({
      canonicalMessageCount: Number.MAX_SAFE_INTEGER + 100,
      working: {
        messages: [],
        stats: {
          sourceMessages: -5,
          projectedMessages: Number.POSITIVE_INFINITY,
          hydratedImages: -1,
          omittedImages: Number.MAX_SAFE_INTEGER + 1,
          unavailableImages: Number.NaN,
        },
      },
      surface: {
        ...surface,
        contextWindowTokens: 0,
        systemIdentity: { bytes: 0, tokens: Number.MAX_SAFE_INTEGER },
        botSystemPrompt: { bytes: 0, tokens: Number.MAX_SAFE_INTEGER },
        tools: { totalBytes: 0, totalTokens: Number.MAX_SAFE_INTEGER, items: [] },
      },
      reserveTokens: -100,
      keepRecentTokens: Number.POSITIVE_INFINITY,
    })

    assert.equal(report.estimatedKnownInputTokens, Number.MAX_SAFE_INTEGER)
    assert.equal(report.usagePercent, 0)
    assert.equal(report.freeTokens, 0)
    assert.deepEqual(report.compaction, {
      reserveTokens: 0,
      keepRecentTokens: 0,
      triggerTokens: 0,
      tokensUntilTrigger: 0,
      overTrigger: true,
    })
    for (const value of Object.values(report.messages)) {
      assert.ok(Number.isSafeInteger(value) && value >= 0)
    }
  })

  test('uses null metadata when no surface or fallbacks exist', () => {
    const report = analyze({
      surface: null,
      surfaceStatus: 'invalid',
      fallbackModel: undefined,
      fallbackProvider: undefined,
      fallbackContextWindowTokens: undefined,
      working: {
        messages: [],
        stats: {
          sourceMessages: 0, projectedMessages: 0, hydratedImages: 0,
          omittedImages: 0, unavailableImages: 0,
        },
      },
    })

    assert.equal(report.model, null)
    assert.equal(report.provider, null)
    assert.equal(report.contextWindowTokens, null)
    assert.equal(report.estimatedKnownInputTokens, 0)
    assert.ok(Object.values(report.categories).every((category) => (
      category.tokens === null || category.tokens === 0
    )))
  })
})
