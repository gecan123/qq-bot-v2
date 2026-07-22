import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import type { MessageAgentLedgerEntry } from './agent-ledger.types.js'
import {
  buildCompactionSummarizerRequest,
  estimateCompactionTextTokens,
  renderCachedClaudeCompactionControl,
  serializeCompactionSources,
  validateCompactionSummary,
} from './compaction-serialization.js'

const CREATED_AT = new Date('2026-07-15T10:00:00.000Z')

function entry(id: bigint, message: AgentMessage): MessageAgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: { schemaVersion: 1, message },
    createdAt: CREATED_AT,
  }
}

function validSummary(body = '保留事实。'): string {
  return [
    '## 讨论过的话题', body,
    '## 群友信息', '无。',
    '## 我的目标、承诺和状态', '继续当前目标。',
    '## 关键约束与决定', '遵守安全边界。',
    '## 工具调用结果', '无。',
    '## 情绪和氛围', '平静。',
    '## 下一步', '继续执行。',
  ].join('\n')
}

describe('compaction serialization', () => {
  test('separates previous summary from newly compressed transcript', () => {
    const result = serializeCompactionSources({
      previousSummary: 'previous durable summary',
      entries: [entry(1n, { role: 'user', content: 'new history' })],
      kind: 'history',
      maxChars: 8_000,
    })

    assert.match(result.previousSummaryEnvelope ?? '', /section=previous_summary/)
    assert.match(result.previousSummaryEnvelope ?? '', /previous durable summary/)
    assert.doesNotMatch(result.previousSummaryEnvelope ?? '', /new history/)
    assert.match(result.transcriptEnvelope, /section=history/)
    assert.match(result.transcriptEnvelope, /new history/)
    assert.doesNotMatch(result.transcriptEnvelope, /previous durable summary/)
  })

  test('includes every selected prefix entry by default', () => {
    const entries = Array.from({ length: 180 }, (_, index) => entry(
      BigInt(index + 1),
      { role: 'user', content: `history-${index}-${'x'.repeat(900)}` },
    ))

    const result = serializeCompactionSources({
      previousSummary: null,
      entries,
      kind: 'history',
    })

    assert.match(result.transcriptEnvelope, /history-0-/)
    assert.match(result.transcriptEnvelope, /history-179-/)
    assert.doesNotMatch(result.transcriptEnvelope, /"omittedMessages"/)
  })

  test('renders stable trusted control for cache-preserving Claude compaction', () => {
    const control = renderCachedClaudeCompactionControl({ maxSummaryTokens: 2_048 })

    for (const heading of [
      '## 讨论过的话题',
      '## 群友信息',
      '## 我的目标、承诺和状态',
      '## 关键约束与决定',
      '## 工具调用结果',
      '## 情绪和氛围',
      '## 下一步',
    ]) assert.match(control, new RegExp(heading))
    assert.match(control, /原始历史前缀将被这份摘要替换/)
    assert.match(control, /后续工作必须能仅凭摘要继续/)
    assert.match(control, /只输出纯文本摘要，不得调用任何工具/)
    assert.match(control, /受控机器状态标记.*权威状态/)
    assert.match(control, /2048/)
    assert.match(control, /保留目标、承诺、关键约束、已确认的工具事实和下一步/)
  })

  test('requires seven ordered non-empty headings and a token budget', () => {
    assert.deepEqual(
      validateCompactionSummary(validSummary(), { maxTokens: 1_000 }),
      { ok: true, summary: validSummary(), tokens: estimateCompactionTextTokens(validSummary()) },
    )
    const wrongOrder = validSummary().replace(
      '## 讨论过的话题\n保留事实。\n## 群友信息\n无。',
      '## 群友信息\n无。\n## 讨论过的话题\n保留事实。',
    )
    assert.equal(
      (validateCompactionSummary(wrongOrder, { maxTokens: 1_000 }) as { reason: string }).reason,
      'invalid_heading_order',
    )
    assert.equal(
      (validateCompactionSummary(
        validSummary().replace('保留事实。', '保留事实。\n## 额外标题\n不允许'),
        { maxTokens: 1_000 },
      ) as { reason: string }).reason,
      'unexpected_heading:## 额外标题',
    )
    assert.equal(
      (validateCompactionSummary(
        validSummary().replace('## 群友信息\n无。', '## 群友信息\n'),
        { maxTokens: 1_000 },
      ) as { reason: string }).reason,
      'empty_section:## 群友信息',
    )
    assert.equal(
      (validateCompactionSummary(validSummary('x'.repeat(10_000)), { maxTokens: 100 }) as { reason: string }).reason,
      'token_limit',
    )
  })
})
