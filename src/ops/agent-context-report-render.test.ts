import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentContextReport } from './agent-context-report.js'
import {
  parseAgentContextArgs,
  renderAgentContextReport,
  renderAgentContextReportJson,
  renderCompactTokens,
} from './agent-context-report-render.js'

const fixtureReport: AgentContextReport = {
  schemaVersion: 1,
  generatedAt: '2026-07-16T12:00:00.000+08:00',
  model: 'claude-opus-4-7',
  provider: 'claude-code',
  contextWindowTokens: 1_000_000,
  estimateMethod: 'local_structure_utf8_bytes',
  estimateComplete: true,
  estimatedKnownInputTokens: 293_400,
  estimatedCurrentInputTokens: 293_400,
  freeTokens: 706_600,
  usagePercent: 29.3,
  compaction: {
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    triggerTokens: 983_616,
    tokensUntilTrigger: 690_216,
    overTrigger: false,
  },
  categories: {
    systemIdentity: { available: true, tokens: 1_200, percent: 0.1 },
    botSystemPrompt: { available: true, tokens: 10_300, percent: 1 },
    visibleTools: { available: true, tokens: 18_100, percent: 1.8 },
    userAndRuntimeMessages: { available: true, tokens: 31_400, percent: 3.1 },
    assistantToolCalls: { available: true, tokens: 22_700, percent: 2.3 },
    assistantThinking: { available: true, tokens: 0, percent: 0 },
    toolResultsText: { available: true, tokens: 207_900, percent: 20.8 },
    workingImages: { available: true, tokens: 1_800, percent: 0.2 },
    assistantText: { available: true, tokens: 0, percent: 0 },
  },
  messages: {
    canonical: 45,
    working: 42,
    hydratedImages: 2,
    omittedImages: 3,
    unavailableImages: 1,
  },
  toolResultContributors: [{ toolName: 'inbox', tokens: 200_000, resultCount: 9 }],
  latestProviderUsage: {
    ts: '2026-07-16T11:59:00.000+08:00',
    model: 'claude-opus-4-7',
    inputTokens: 291_800,
    cachedTokens: 286_100,
    outputTokens: 1_234,
  },
  surfaceStatus: 'live',
  warnings: ['Example aggregate warning.'],
}

test('default rendering shows the complete operational context summary', () => {
  const text = renderAgentContextReport(fixtureReport)

  assert.match(text, /^Context Usage/m)
  assert.match(text, /Model: claude-opus-4-7/)
  assert.match(text, /Provider: claude-code/)
  assert.match(text, /Window: 1\.0m/)
  assert.match(text, /Estimated current: 293\.4k \(29\.3%\)/)
  assert.match(text, /Latest provider input: 291\.8k/)
  assert.match(text, /System identity/)
  assert.match(text, /Visible tools/)
  assert.match(text, /Assistant thinking/)
  assert.match(text, /Free space/)
  assert.match(text, /Compaction trigger: 983\.6k/)
  assert.match(text, /headroom 690\.2k/)
  assert.match(text, /Projection: canonical 45 · working 42/)
  assert.match(text, /Images: hydrated 2 · omitted 3 · unavailable 1/)
  assert.match(text, /Top tool-result contributors:\n- inbox\s+200\.0k\s+9 results/)
  assert.match(text, /Estimate: local_structure_utf8_bytes/)
  assert.match(text, /Surface: live/)
  assert.match(text, /Warnings:\n- Example aggregate warning\./)
  assert.equal(/\u001b\[[0-9;]*m/.test(text), false)
})

test('unavailable values render as n/a without exposing report-adjacent sensitive data', () => {
  const partial = {
    ...fixtureReport,
    model: null,
    provider: null,
    contextWindowTokens: null,
    estimateComplete: false,
    estimatedCurrentInputTokens: null,
    freeTokens: null,
    usagePercent: null,
    compaction: {
      ...fixtureReport.compaction,
      triggerTokens: null,
      tokensUntilTrigger: null,
      overTrigger: null,
    },
    categories: {
      ...fixtureReport.categories,
      visibleTools: { available: false, tokens: null, percent: null },
    },
    latestProviderUsage: null,
    surfaceStatus: 'missing' as const,
    systemPrompt: 'SYSTEM_PROMPT_MUST_NOT_RENDER',
    args: { secret: 'ARGS_MUST_NOT_RENDER' },
    image: 'BASE64_MUST_NOT_RENDER',
  } satisfies AgentContextReport & Record<string, unknown>

  const text = renderAgentContextReport(partial)

  assert.match(text, /Model: n\/a/)
  assert.match(text, /Provider: n\/a/)
  assert.match(text, /Window: n\/a/)
  assert.match(text, /Estimated current: n\/a/)
  assert.match(text, /Latest provider input: n\/a/)
  assert.match(text, /Visible tools\s+n\/a\s+n\/a/)
  assert.equal(text.includes('SYSTEM_PROMPT_MUST_NOT_RENDER'), false)
  assert.equal(text.includes('ARGS_MUST_NOT_RENDER'), false)
  assert.equal(text.includes('BASE64_MUST_NOT_RENDER'), false)
})

test('compact token rendering is deterministic for large values', () => {
  assert.equal(renderCompactTokens(0), '0')
  assert.equal(renderCompactTokens(999), '999')
  assert.equal(renderCompactTokens(1_000), '1.0k')
  assert.equal(renderCompactTokens(12_345), '12.3k')
  assert.equal(renderCompactTokens(999_999), '1.0m')
  assert.equal(renderCompactTokens(1_000_000), '1.0m')
  assert.equal(renderCompactTokens(999_999_999), '1.0b')
  assert.equal(renderCompactTokens(2_500_000_000), '2.5b')
  assert.throws(() => renderCompactTokens(1.5), /non-negative safe integer/)
  assert.throws(() => renderCompactTokens(Number.MAX_SAFE_INTEGER + 1), /non-negative safe integer/)
})

test('terminal rendering escapes controls in contributor names and warnings', () => {
  const text = renderAgentContextReport({
    ...fixtureReport,
    toolResultContributors: [{
      toolName: 'inbox\n\u001b[31mspoof',
      tokens: 12,
      resultCount: 1,
    }],
    warnings: ['warning\r\nspoof'],
  })

  assert.equal(text.includes('\u001b'), false)
  assert.equal(text.includes('inbox\n'), false)
  assert.equal(text.includes('warning\r'), false)
  assert.match(text, /inbox\\u000a\\u001b\[31mspoof/)
  assert.match(text, /warning\\u000d\\u000aspoof/)
})

test('argument parsing accepts only the documented json forms', () => {
  assert.deepEqual(parseAgentContextArgs([]), { json: false })
  assert.deepEqual(parseAgentContextArgs(['--json']), { json: true })
  assert.deepEqual(parseAgentContextArgs(['--', '--json']), { json: true })
  assert.throws(() => parseAgentContextArgs(['--watch']), /unknown argument: --watch/)
  assert.throws(() => parseAgentContextArgs(['--']), /unknown argument: --/)
  assert.throws(() => parseAgentContextArgs(['--json', '--json']), /unknown argument/)
})

test('json rendering preserves the versioned report without BigInt values', () => {
  const json = renderAgentContextReportJson(fixtureReport)
  const parsed = JSON.parse(json) as AgentContextReport

  assert.equal(parsed.schemaVersion, 1)
  assert.deepEqual(parsed, fixtureReport)
  assert.doesNotThrow(() => JSON.stringify(parsed))
})
