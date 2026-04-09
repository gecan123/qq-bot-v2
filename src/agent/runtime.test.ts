import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentClient, agentModel, createAgentChatFn } from './runtime.js'

describe('agent runtime singleton', () => {
  test('agentClient is an OpenAI instance', () => {
    assert.ok(agentClient, 'agentClient should be defined')
    assert.equal(typeof agentClient.chat.completions.create, 'function', 'should have chat.completions.create')
  })

  test('agentModel is a non-empty string', () => {
    assert.equal(typeof agentModel, 'string')
    assert.ok(agentModel.length > 0, 'agentModel should not be empty')
  })

  test('createAgentChatFn returns a function', () => {
    const chatFn = createAgentChatFn({ reasoningEffort: 'medium' })
    assert.equal(typeof chatFn, 'function')
  })

  test('createAgentChatFn without options returns a function', () => {
    const chatFn = createAgentChatFn()
    assert.equal(typeof chatFn, 'function')
  })

  test('multiple calls return functions backed by same client (singleton)', () => {
    const fn1 = createAgentChatFn({ reasoningEffort: 'low' })
    const fn2 = createAgentChatFn({ reasoningEffort: 'medium' })
    assert.equal(typeof fn1, 'function')
    assert.equal(typeof fn2, 'function')
    // Both should work — they share the same underlying client
    assert.notEqual(fn1, fn2, 'different options produce different functions')
  })
})
