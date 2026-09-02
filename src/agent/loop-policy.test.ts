import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decideLoopPolicy, type LoopPolicyInput } from './loop-policy.js'

const base: LoopPolicyInput = {
  ranRound: true, stopRequested: false, toolCallCount: 0, demand: 'none',
  recoverableToolFailure: false, onlyHelpToolCalls: false, madeToolProgress: false,
  recoverableCorrectionRounds: 0,
  maxRecoverableCorrectionRounds: 3,
  noProgressRounds: 0,
  maxNoProgressRounds: 2,
}

describe('loop policy', () => {
  test('maps representative loop states to explicit continuation decisions', () => {
    const cases: Array<[Partial<LoopPolicyInput>, string, string?]> = [
      [{ ranRound: false }, 'wait_event', 'no_actionable_context'],
      [{ stopRequested: true }, 'stop'],
      [{ toolCallCount: 1, recoverableToolFailure: true }, 'continue', 'recoverable_tool_correction'],
      [{ toolCallCount: 1, madeToolProgress: true, toolContinuation: 'immediate' }, 'continue', 'tool_immediate'],
      [{ toolCallCount: 1, toolContinuation: 'wait_event' }, 'wait_event', 'tool_external_started'],
      [{ toolCallCount: 1, toolContinuation: 'wait_attention' }, 'wait_event', 'tool_direction_complete'],
      [{ toolCallCount: 1, toolContinuation: 'stop' }, 'wait_event', 'tool_direction_complete'],
      [{ toolCallCount: 1, toolContinuation: 'backoff' }, 'wait_attention', 'tool_backoff'],
      [{ toolCallCount: 1, madeToolProgress: true }, 'continue', 'tool_progress'],
      [{ toolCallCount: 1 }, 'continue', 'tool_no_progress'],
      [{ demand: 'continuation' }, 'continue', 'action_correction'],
      [{}, 'wait_event', 'direction_complete'],
    ]
    for (const [overrides, action, reason] of cases) {
      const decision = decideLoopPolicy({ ...base, ...overrides })
      assert.equal(decision.action, action)
      if (reason) assert.equal('reason' in decision ? decision.reason : undefined, reason)
    }
  })

  test('caps immediate recoverable correction rounds before returning to the normal loop', () => {
    const decision = decideLoopPolicy({
      ...base, toolCallCount: 1, recoverableToolFailure: true,
      recoverableCorrectionRounds: 3,
    })
    assert.equal(decision.action, 'continue')
    assert.equal('reason' in decision ? decision.reason : undefined, 'tool_no_progress')
  })

  test('parks after two consecutive no-progress tool rounds', () => {
    const first = decideLoopPolicy({
      ...base,
      toolCallCount: 1,
    })
    assert.equal(first.action, 'continue')
    assert.equal(first.noProgressRounds, 1)

    const second = decideLoopPolicy({
      ...base,
      toolCallCount: 1,
      noProgressRounds: first.noProgressRounds,
    })
    assert.equal(second.action, 'wait_event')
    assert.equal('reason' in second ? second.reason : undefined, 'no_progress_limit')
    assert.equal(second.noProgressRounds, 0)
  })

  test('immediate continuation does not reset no-progress rounds', () => {
    const first = decideLoopPolicy({
      ...base, toolCallCount: 1, toolContinuation: 'immediate',
    })
    assert.equal(first.action, 'continue')
    assert.equal('reason' in first ? first.reason : undefined, 'tool_immediate')
    assert.equal(first.noProgressRounds, 1)

    const second = decideLoopPolicy({
      ...base,
      toolCallCount: 1,
      toolContinuation: 'immediate',
      noProgressRounds: first.noProgressRounds,
    })
    assert.equal(second.action, 'wait_event')
    assert.equal('reason' in second ? second.reason : undefined, 'no_progress_limit')
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
