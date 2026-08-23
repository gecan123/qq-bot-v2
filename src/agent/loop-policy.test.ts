import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decideLoopPolicy, type LoopPolicyInput } from './loop-policy.js'

const base: LoopPolicyInput = {
  ranRound: true, stopRequested: false, toolCallCount: 0, actionRequired: false,
  recoverableToolFailure: false, onlyHelpToolCalls: false, madeToolProgress: false,
  requestedYield: false, correctionRetryPending: false, recoverableCorrectionRounds: 0,
  maxRecoverableCorrectionRounds: 3,
}

describe('loop policy', () => {
  test('maps representative loop states to explicit continuation decisions', () => {
    const cases: Array<[Partial<LoopPolicyInput>, string, string?]> = [
      [{ ranRound: false }, 'wait_event', 'empty_context'],
      [{ stopRequested: true }, 'stop'],
      [{ toolCallCount: 1, recoverableToolFailure: true }, 'continue', 'recoverable_tool_correction'],
      [{ toolCallCount: 1, toolContinuation: 'immediate' }, 'continue', 'tool_immediate'],
      [{ toolCallCount: 1, toolContinuation: 'wait_event' }, 'wait_event', 'tool_external'],
      [{ toolCallCount: 1, toolContinuation: 'backoff' }, 'wait_attention', 'tool_backoff'],
      [{ toolCallCount: 1, madeToolProgress: true }, 'continue', 'tool_progress'],
      [{ actionRequired: true }, 'continue', 'action_correction'],
      [{ actionRequired: true, correctionRetryPending: true }, 'wait_attention', 'action_correction'],
      [{}, 'wait_attention', 'quiescent'],
    ]
    for (const [overrides, action, reason] of cases) {
      const decision = decideLoopPolicy({ ...base, ...overrides })
      assert.equal(decision.action, action)
      if (reason) assert.equal('reason' in decision ? decision.reason : undefined, reason)
    }
  })

  test('caps immediate recoverable correction rounds', () => {
    const decision = decideLoopPolicy({
      ...base, toolCallCount: 1, recoverableToolFailure: true,
      recoverableCorrectionRounds: 3,
    })
    assert.equal(decision.action, 'wait_attention')
    assert.equal('reason' in decision ? decision.reason : undefined, 'tool_no_progress')
  })

  test('yield only schedules autonomous idle follow-up when no action remains', () => {
    const decision = decideLoopPolicy({
      ...base, toolCallCount: 1, requestedYield: true, toolContinuation: 'stop',
    })
    assert.equal(decision.action, 'wait_attention')
    assert.equal(decision.action === 'wait_attention' ? decision.recordIdle : null, 'yield')
  })
})
