import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildLlmRequest } from './build-llm-request.js'
import type { AgentMessage } from './types.js'
import type { AgentContextSnapshot } from './agent-context.js'

describe('buildLlmRequest', () => {
  test('empty suffix returns snapshot messages as-is (semantically equal)', () => {
    const snapshot: AgentContextSnapshot = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'model', content: 'hello' },
      ],
    }

    const { messages } = buildLlmRequest(snapshot)

    assert.deepEqual(messages, snapshot.messages)
  })

  test('non-empty suffix appends after snapshot', () => {
    const snapshot: AgentContextSnapshot = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'model', content: 'hello' },
      ],
    }
    const suffix: AgentMessage[] = [
      { role: 'user', content: '[内部状态] note A' },
    ]

    const { messages } = buildLlmRequest(snapshot, suffix)

    assert.deepEqual(messages, [
      { role: 'user', content: 'hi' },
      { role: 'model', content: 'hello' },
      { role: 'user', content: '[内部状态] note A' },
    ])
  })

  test('does not mutate snapshot.messages', () => {
    const original: AgentMessage[] = [{ role: 'user', content: 'hi' }]
    const snapshot: AgentContextSnapshot = { messages: original }
    const suffix: AgentMessage[] = [{ role: 'user', content: 'tail' }]

    buildLlmRequest(snapshot, suffix)

    // 原数组没被改动
    assert.equal(original.length, 1)
    assert.deepEqual(original, [{ role: 'user', content: 'hi' }])
  })

  test('snapshot order is preserved before suffix order', () => {
    const snapshot: AgentContextSnapshot = {
      messages: [
        { role: 'user', content: 'msg-1' },
        { role: 'model', content: 'msg-2' },
        { role: 'user', content: 'msg-3' },
      ],
    }
    const suffix: AgentMessage[] = [
      { role: 'user', content: 'suffix-1' },
      { role: 'user', content: 'suffix-2' },
    ]

    const { messages } = buildLlmRequest(snapshot, suffix)

    assert.deepEqual(
      messages.map((m) => m.role === 'user' || m.role === 'model' ? m.content : undefined),
      ['msg-1', 'msg-2', 'msg-3', 'suffix-1', 'suffix-2'],
    )
  })
})
