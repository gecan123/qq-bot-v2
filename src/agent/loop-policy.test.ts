import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decideLoopPolicy, type LoopPolicyInput } from './loop-policy.js'

const base: LoopPolicyInput = {
  ranRound: true, stopRequested: false, toolCallCount: 0, demand: 'none',
  recoverableToolFailure: false, onlyHelpToolCalls: false, madeToolProgress: false,
  correctionRetryPending: false, recoverableCorrectionRounds: 0,
  maxRecoverableCorrectionRounds: 3,
}

describe('loop policy', () => {
  test('maps representative loop states to explicit continuation decisions', () => {
    const cases: Array<[Partial<LoopPolicyInput>, string, string?]> = [
      [{ ranRound: false }, 'wait_event', 'no_actionable_context'],
      [{ stopRequested: true }, 'stop'],
      [{ toolCallCount: 1, recoverableToolFailure: true }, 'continue', 'recoverable_tool_correction'],
      [{ toolCallCount: 1, toolContinuation: 'immediate' }, 'continue', 'tool_immediate'],
      [{ toolCallCount: 1, toolContinuation: 'wait_event' }, 'continue', 'tool_external_started'],
      [{ toolCallCount: 1, toolContinuation: 'wait_attention' }, 'continue', 'tool_direction_complete'],
      [{ toolCallCount: 1, toolContinuation: 'stop' }, 'continue', 'tool_direction_complete'],
      [{ toolCallCount: 1, toolContinuation: 'backoff' }, 'wait_attention', 'tool_backoff'],
      [{ toolCallCount: 1, madeToolProgress: true }, 'continue', 'tool_progress'],
      [{ toolCallCount: 1 }, 'continue', 'tool_no_progress'],
      [{ demand: 'continuation' }, 'continue', 'action_correction'],
      [{ demand: 'continuation', correctionRetryPending: true }, 'wait_attention', 'action_correction'],
      [{}, 'continue', 'seek_next_action'],
    ]
    for (const [overrides, action, reason] of cases) {
      const decision = decideLoopPolicy({ ...base, ...overrides })
      assert.equal(decision.action, action)
      if (reason) assert.equal('reason' in decision ? decision.reason : undefined, reason)
    }
  })

  test('caps immediate recoverable correction rounds by switching direction', () => {
    const decision = decideLoopPolicy({
      ...base, toolCallCount: 1, recoverableToolFailure: true,
      recoverableCorrectionRounds: 3,
    })
    assert.equal(decision.action, 'continue')
    assert.equal('reason' in decision ? decision.reason : undefined, 'tool_no_progress')
  })

  test('pending attention outranks unrelated tool progress', () => {
    const decision = decideLoopPolicy({
      ...base,
      toolCallCount: 1,
      madeToolProgress: true,
      demand: 'attention',
    })
    assert.equal(decision.action, 'continue')
    assert.equal('reason' in decision ? decision.reason : undefined, 'attention_pending')
  })
})
