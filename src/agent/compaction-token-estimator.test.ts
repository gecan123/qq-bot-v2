import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import type { AgentLedgerEntry } from './agent-ledger.types.js'

const CREATED_AT = new Date('2026-07-15T10:00:00.000Z')

function entry(id: bigint, message: AgentMessage): AgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: { schemaVersion: 1, message },
    createdAt: CREATED_AT,
  }
}

describe('compaction token estimator', () => {
  test('uses the latest provider input as an exact prefix and estimates only newer entries', async () => {
    const estimator = await import('./compaction-token-estimator.js')
    const entries = [
      entry(1n, { role: 'user', content: 'provider 已经看过' }),
      entry(2n, { role: 'user', content: 'provider 调用后新增' }),
    ]

    const suffix = estimator.estimateEntryTokens(entries[1]!)
    const result = estimator.estimateLedgerContextTokens({
      entries,
      providerPrefix: { throughEntryId: 1n, inputTokens: 100 },
    })

    assert.equal(result.tokens, 100 + suffix.tokens)
    assert.equal(result.source, 'provider_prefix')
    assert.deepEqual(result.estimatedEntryIds, [2n])
  })

  test('prefers local structure estimation for native blocks, tool schemas, and block results', async () => {
    const estimator = await import('./compaction-token-estimator.js')
    const structured: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
        toolCalls: [{ id: 'call-1', name: 'lookup', args: { query: 'weather' } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
    ]

    for (const [index, message] of structured.entries()) {
      const estimate = estimator.estimateEntryTokens(entry(BigInt(index + 1), message))
      assert.equal(estimate.source, 'local_structure')
      assert.ok(estimate.tokens > 0)
    }
  })

  test('falls back to deterministic bounded UTF-8 byte estimation for plain messages', async () => {
    const estimator = await import('./compaction-token-estimator.js')
    const ascii = estimator.estimateEntryTokens(entry(1n, { role: 'user', content: 'abcd' }))
    const chinese = estimator.estimateEntryTokens(entry(2n, { role: 'user', content: '测试测试' }))

    assert.equal(ascii.source, 'utf8_bytes')
    assert.equal(chinese.source, 'utf8_bytes')
    assert.ok(ascii.tokens >= 1)
    assert.ok(chinese.tokens > ascii.tokens)
    assert.equal(Number.isSafeInteger(chinese.tokens), true)
  })
})
