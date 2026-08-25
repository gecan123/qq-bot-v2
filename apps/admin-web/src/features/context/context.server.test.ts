import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildContextEntryViews } from './context.server.js'

describe('buildContextEntryViews', () => {
  test('groups a tool result under its assistant call and exposes semantic summaries', () => {
    const entries = buildContextEntryViews([
      ledgerRow(103n, 'message', {
        schemaVersion: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-yield',
          content: JSON.stringify({
            ok: true,
            status: 'yielded',
            reason: '已完成当前动作，等待新输入。',
          }),
        },
      }),
      ledgerRow(102n, 'message', {
        schemaVersion: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-yield', name: 'yield', args: { reason: '等待新输入' } }],
        },
      }),
      ledgerRow(101n, 'compaction', {
        schemaVersion: 1,
        summary: '## 历史摘要\n保留最近一次工具回合。',
        firstKeptEntryId: '90',
        tokensBefore: 12_000,
        estimatedTokensAfter: 4_000,
        reason: 'threshold',
        isSplitTurn: false,
        previousCompactionEntryId: null,
        mailboxAttentionState: {},
      }),
    ])

    assert.deepEqual(entries.map(entry => entry.id), ['101', '102', '103'])
    assert.deepEqual(entries[1], {
      kind: 'message',
      id: '102',
      entryType: 'message',
      createdAt: '2026-07-26T08:00:00.000Z',
      role: 'assistant',
      summary: '',
      toolCalls: [{
        id: 'call-yield',
        name: 'yield',
        displayName: 'yield',
        transportName: null,
        argsPreview: '{\n  "reason": "等待新输入"\n}',
        parameters: [{ label: 'reason', value: '等待新输入' }],
      }],
      toolCallId: null,
      toolName: null,
      parentEntryId: null,
      result: null,
      rawPreview: JSON.stringify({
        schemaVersion: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-yield', name: 'yield', args: { reason: '等待新输入' } }],
        },
      }, null, 2),
    })
    assert.deepEqual(entries[2], {
      kind: 'message',
      id: '103',
      entryType: 'message',
      createdAt: '2026-07-26T08:00:00.000Z',
      role: 'tool',
      summary: '已完成当前动作，等待新输入。',
      toolCalls: [],
      toolCallId: 'call-yield',
      toolName: 'yield',
      parentEntryId: '102',
      result: {
        ok: true,
        status: 'yielded',
        code: null,
        reason: '已完成当前动作，等待新输入。',
      },
      rawPreview: JSON.stringify({
        schemaVersion: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-yield',
          content: JSON.stringify({
            ok: true,
            status: 'yielded',
            reason: '已完成当前动作，等待新输入。',
          }),
        },
      }, null, 2),
    })
    assert.deepEqual(entries[0], {
      kind: 'compaction',
      id: '101',
      entryType: 'compaction',
      createdAt: '2026-07-26T08:00:00.000Z',
      role: null,
      summary: '## 历史摘要\n保留最近一次工具回合。',
      reason: 'threshold',
      firstKeptEntryId: '90',
      tokensBefore: 12_000,
      estimatedTokensAfter: 4_000,
      isSplitTurn: false,
      rawPreview: JSON.stringify({
        schemaVersion: 1,
        summary: '## 历史摘要\n保留最近一次工具回合。',
        firstKeptEntryId: '90',
        tokensBefore: 12_000,
        estimatedTokensAfter: 4_000,
        reason: 'threshold',
        isSplitTurn: false,
        previousCompactionEntryId: null,
        mailboxAttentionState: {},
      }, null, 2),
    })
  })

  test('keeps malformed or future entry payloads observable without pretending to understand them', () => {
    const entries = buildContextEntryViews([
      ledgerRow(104n, 'message', { schemaVersion: 99, unexpected: 'value' }),
    ])

    assert.equal(entries[0]?.kind, 'unknown')
    assert.equal(entries[0]?.entryType, 'message')
    assert.match(entries[0]?.rawPreview ?? '', /"unexpected": "value"/)
  })

  test('does not repeat a tool result body when status fields already contain all information', () => {
    const entries = buildContextEntryViews([
      ledgerRow(105n, 'message', {
        schemaVersion: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-yield',
          content: JSON.stringify({ ok: true, status: 'yielded' }),
        },
      }),
    ])

    assert.equal(entries[0]?.kind, 'message')
    assert.equal(entries[0]?.summary, '')
  })

  test('keeps long Markdown message bodies readable in the bounded conversation snapshot', () => {
    const content = `## 长回复\n\n${'正文内容。'.repeat(300)}`
    const entries = buildContextEntryViews([
      ledgerRow(106n, 'message', {
        schemaVersion: 1,
        message: { role: 'assistant', content, toolCalls: [] },
      }),
    ])

    assert.equal(entries[0]?.kind, 'message')
    assert.equal(entries[0]?.summary, content)
  })

  test('exposes the effective deferred tool and human-readable key parameters', () => {
    const entries = buildContextEntryViews([
      ledgerRow(107n, 'message', {
        schemaVersion: 1,
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call-open',
            name: 'invoke',
            args: {
              tool: 'conversation',
              args: {
                action: 'open',
                target: {
                  kind: 'private',
                  platform: 'qq',
                  accountId: '10000',
                  externalId: '3999414673',
                },
              },
            },
          }],
        },
      }),
    ])

    assert.equal(entries[0]?.kind, 'message')
    assert.deepEqual(entries[0]?.toolCalls, [{
      id: 'call-open',
      name: 'invoke',
      displayName: 'conversation',
      transportName: 'invoke',
      argsPreview: JSON.stringify({
        action: 'open',
        target: {
          kind: 'private',
          platform: 'qq',
          accountId: '10000',
          externalId: '3999414673',
        },
      }, null, 2),
      parameters: [
        { label: 'action', value: 'open' },
        { label: 'target', value: 'QQ 私聊 · 3999414673' },
      ],
    }])
  })
})

function ledgerRow(id: bigint, entryType: string, payload: unknown) {
  return {
    id,
    entryType,
    payload,
    createdAt: new Date('2026-07-26T08:00:00.000Z'),
  }
}
