import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION, type DurableAgentMessage } from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
  type CompactionLedgerPayload,
} from './agent-ledger.types.js'
import {
  AgentLedgerIntegrityError,
  projectAgentLedger,
} from './agent-ledger-projection.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'

const CREATED_AT = new Date('2026-07-15T10:00:00.000Z')

function messageEntry(id: bigint, message: DurableAgentMessage): AgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message },
    createdAt: CREATED_AT,
  }
}

function compactionEntry(
  id: bigint,
  input: Partial<CompactionLedgerPayload> & Pick<CompactionLedgerPayload, 'summary'>,
): AgentLedgerEntry {
  return {
    id,
    entryType: 'compaction',
    payload: {
      schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
      summary: input.summary,
      firstKeptEntryId: input.firstKeptEntryId ?? null,
      tokensBefore: input.tokensBefore ?? 100_000,
      estimatedTokensAfter: input.estimatedTokensAfter ?? 20_000,
      reason: input.reason ?? 'threshold',
      isSplitTurn: input.isSplitTurn ?? false,
      previousCompactionEntryId: input.previousCompactionEntryId ?? null,
      mailboxAttentionState: input.mailboxAttentionState ?? {},
      restResumeState: input.restResumeState ?? null,
      ...(input.manualFocus === undefined ? {} : { manualFocus: input.manualFocus }),
    },
    createdAt: CREATED_AT,
  }
}

function runtimeState(
  ledgerHeadEntryId: bigint | null,
  overrides: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    lastWakeAt: null,
    ledgerHeadEntryId,
    ...overrides,
  }
}

function assistantWithTool(callId: string): DurableAgentMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: callId, name: 'lookup', args: { query: 'weather' } }],
  }
}

function toolResult(callId: string, content = '{"ok":true}'): DurableAgentMessage {
  return { role: 'tool', toolCallId: callId, content }
}

describe('projectAgentLedger', () => {
  test('projects every message entry when no compaction exists', () => {
    const messages: DurableAgentMessage[] = [
      { role: 'user', content: '问题' },
      assistantWithTool('call-1'),
      toolResult('call-1'),
      { role: 'assistant', content: '', toolCalls: [] },
    ]
    const entries = messages.map((message, index) => messageEntry(BigInt(index + 1), message))

    const projection = projectAgentLedger({ entries, runtimeState: runtimeState(4n) })

    assert.deepEqual(projection, {
      throughEntryId: 4n,
      activeEntryCount: 4,
      permanentEntryCount: 4,
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages,
        activeToolCapabilities: [],
      },
    })
  })

  test('accepts stable image refs and rejects base64 in canonical entries', () => {
    const refMessage: DurableAgentMessage = {
      role: 'tool',
      toolCallId: 'image-1',
      content: [{
        type: 'image_ref',
        mediaId: '42',
        mediaType: 'image/png',
        width: 640,
        height: 480,
        description: 'saved image',
      }],
    }
    const projection = projectAgentLedger({
      entries: [messageEntry(1n, assistantWithTool('image-1')), messageEntry(2n, refMessage)],
      runtimeState: runtimeState(2n),
    })
    assert.deepEqual(projection.snapshot.messages[1], refMessage)
    assert.doesNotMatch(JSON.stringify(projection.snapshot), /"type":"base64"/)

    const unsafe = messageEntry(2n, refMessage) as unknown as {
      payload: { message: unknown }
    }
    unsafe.payload.message = {
      role: 'tool',
      toolCallId: 'image-1',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
      }],
    }
    assert.throws(
      () => projectAgentLedger({
        entries: [messageEntry(1n, assistantWithTool('image-1')), unsafe as never],
        runtimeState: runtimeState(2n),
      }),
      /type is unsupported: image/,
    )
  })

  test('projects fixed summary and sorted machine state before the kept tail', () => {
    const entries: AgentLedgerEntry[] = [
      messageEntry(1n, { role: 'user', content: '旧问题' }),
      messageEntry(2n, { role: 'user', content: '保留问题' }),
      compactionEntry(3n, {
        summary: '旧问题已经处理。',
        firstKeptEntryId: '2',
        mailboxAttentionState: {
          'qq_private:20': { disclosedThroughRowId: 9, handledThroughRowId: 8 },
          'qq_group:10': { disclosedThroughRowId: 7, handledThroughRowId: 7 },
        },
        restResumeState: {
          emittedAt: '2026-07-15T18:00:00+08:00',
          nonPauseActionSince: true,
        },
      }),
      messageEntry(4n, { role: 'user', content: '新问题' }),
    ]

    const projection = projectAgentLedger({
      entries,
      runtimeState: runtimeState(4n, { activeToolCapabilities: ['browser'] }),
    })

    assert.deepEqual(projection.snapshot, {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      activeToolCapabilities: ['browser'],
      messages: [
        {
          role: 'user',
          content: '[历史摘要]\n旧问题已经处理。\n\n[rest_resume_state]\n'
            + '{"event":"rest_resume_state","emittedAt":"2026-07-15T18:00:00+08:00","nonPauseActionSince":true}',
        },
        {
          role: 'user',
          content: '{"event":"mailbox_attention_state","mailboxes":'
            + '{"qq_group:10":{"disclosedThroughRowId":7,"handledThroughRowId":7},'
            + '"qq_private:20":{"disclosedThroughRowId":9,"handledThroughRowId":8}}}',
        },
        { role: 'user', content: '保留问题' },
        { role: 'user', content: '新问题' },
      ],
    })
    assert.equal(projection.activeEntryCount, 2)
    assert.equal(projection.permanentEntryCount, 4)
  })

  test('uses only the latest compaction and keeps messages on both sides of it', () => {
    const entries: AgentLedgerEntry[] = [
      messageEntry(1n, { role: 'user', content: '最旧消息' }),
      compactionEntry(2n, { summary: '第一版摘要' }),
      messageEntry(3n, { role: 'user', content: '中间消息' }),
      compactionEntry(4n, {
        summary: '第二版摘要',
        firstKeptEntryId: '3',
        previousCompactionEntryId: '2',
      }),
      messageEntry(5n, { role: 'user', content: '最新消息' }),
    ]

    const projection = projectAgentLedger({ entries, runtimeState: runtimeState(5n) })

    assert.deepEqual(projection.snapshot.messages, [
      { role: 'user', content: '[历史摘要]\n第二版摘要' },
      { role: 'user', content: '中间消息' },
      { role: 'user', content: '最新消息' },
    ])
    assert.equal(JSON.stringify(projection.snapshot).includes('第一版摘要'), false)
  })

  test('is byte deterministic for identical ledger and runtime inputs', () => {
    const entries: AgentLedgerEntry[] = [
      messageEntry(1n, { role: 'user', content: '旧消息' }),
      compactionEntry(2n, {
        summary: '摘要',
        mailboxAttentionState: {
          'qq_private:2': { disclosedThroughRowId: 3, handledThroughRowId: 1 },
          'qq_group:1': { disclosedThroughRowId: 2, handledThroughRowId: 2 },
        },
      }),
    ]
    const state = runtimeState(2n, { activeToolCapabilities: ['media_generation', 'browser'] })

    const first = projectAgentLedger({ entries, runtimeState: state })
    const second = projectAgentLedger({ entries, runtimeState: state })

    assert.equal(JSON.stringify(first.snapshot), JSON.stringify(second.snapshot))
  })

  test('rejects a compaction boundary that starts on a tool result', () => {
    const entries: AgentLedgerEntry[] = [
      messageEntry(1n, assistantWithTool('call-1')),
      messageEntry(2n, toolResult('call-1')),
      compactionEntry(3n, { summary: '摘要', firstKeptEntryId: '2' }),
    ]

    assert.throws(
      () => projectAgentLedger({ entries, runtimeState: runtimeState(3n) }),
      (error: unknown) => error instanceof AgentLedgerIntegrityError
        && /boundary.*tool result/.test(error.message),
    )
  })

  test('rejects missing and orphan tool results', () => {
    const cases: Array<{ name: string; entries: AgentLedgerEntry[]; expected: RegExp }> = [
      {
        name: 'missing result',
        entries: [messageEntry(1n, assistantWithTool('call-1'))],
        expected: /must be tool result for assistant tool call call-1/,
      },
      {
        name: 'orphan result',
        entries: [messageEntry(1n, toolResult('orphan'))],
        expected: /orphan tool result orphan/,
      },
    ]

    for (const item of cases) {
      assert.throws(
        () => projectAgentLedger({
          entries: item.entries,
          runtimeState: runtimeState(item.entries.at(-1)?.id ?? null),
        }),
        (error: unknown) => error instanceof AgentLedgerIntegrityError
          && item.expected.test(error.message),
        item.name,
      )
    }
  })

  test('fails closed for unknown entry type, payload schema, and broken compaction chain', () => {
    const cases: Array<{ name: string; entries: AgentLedgerEntry[]; expected: RegExp }> = [
      {
        name: 'entry type',
        entries: [{
          ...messageEntry(1n, { role: 'user', content: 'x' }),
          entryType: 'future',
        } as unknown as AgentLedgerEntry],
        expected: /unknown entry type/,
      },
      {
        name: 'schema version',
        entries: [{
          ...messageEntry(1n, { role: 'user', content: 'x' }),
          payload: { schemaVersion: 2, message: { role: 'user', content: 'x' } },
        } as unknown as AgentLedgerEntry],
        expected: /unsupported message schemaVersion/,
      },
      {
        name: 'compaction chain',
        entries: [
          compactionEntry(1n, { summary: 'one' }),
          compactionEntry(2n, { summary: 'two', previousCompactionEntryId: '99' }),
        ],
        expected: /previousCompactionEntryId/,
      },
    ]

    for (const item of cases) {
      assert.throws(
        () => projectAgentLedger({
          entries: item.entries,
          runtimeState: runtimeState(item.entries.at(-1)?.id ?? null),
        }),
        (error: unknown) => error instanceof AgentLedgerIntegrityError
          && item.expected.test(error.message),
        item.name,
      )
    }
  })

  test('rejects non-increasing IDs and runtime head drift', () => {
    assert.throws(
      () => projectAgentLedger({
        entries: [
          messageEntry(2n, { role: 'user', content: 'first' }),
          messageEntry(1n, { role: 'user', content: 'second' }),
        ],
        runtimeState: runtimeState(1n),
      }),
      /strictly increasing/,
    )

    assert.throws(
      () => projectAgentLedger({
        entries: [messageEntry(1n, { role: 'user', content: 'x' })],
        runtimeState: runtimeState(2n),
      }),
      /ledger head/,
    )
  })

  test('rejects non-JSON values hidden inside message payloads', () => {
    const message = assistantWithTool('call-1')
    if (message.role !== 'assistant') assert.fail('fixture must be an assistant message')
    message.toolCalls[0]!.args = { when: new Date('2026-07-15T10:00:00.000Z') }

    assert.throws(
      () => projectAgentLedger({
        entries: [messageEntry(1n, message), messageEntry(2n, toolResult('call-1'))],
        runtimeState: runtimeState(2n),
      }),
      /must be an object|non-JSON/,
    )
  })
})
