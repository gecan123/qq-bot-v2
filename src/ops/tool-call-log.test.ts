import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyBotToolPolicy } from '../agent/tools/policies.js'

function isSideEffectTool(toolName: string, args: Record<string, unknown>): boolean {
  return classifyBotToolPolicy(toolName, args).sideEffect
}

describe('tool-call-log side effect classification', () => {
  test('classifies Moomoo reads separately from simulated trading writes', () => {
    for (const command of [
      'check_env',
      'quote/get_snapshot US.AAPL',
      'trade/get_portfolio --trd-env SIMULATE',
    ]) {
      assert.equal(isSideEffectTool('moomoo_skill', { command }), false, command)
    }

    for (const command of [
      'trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
      'trade/modify_order --order-id 123 --price 101 --trd-env SIMULATE',
      'trade/cancel_order --order-id 123 --trd-env SIMULATE',
      'unknown',
    ]) {
      assert.equal(isSideEffectTool('moomoo_skill', { command }), true, command)
    }
  })

  test('classifies local crypto paper reads separately from simulated writes', () => {
    for (const action of ['account', 'portfolio', 'orders']) {
      assert.equal(isSideEffectTool('crypto_paper', { action }), false, action)
    }
    for (const action of ['buy', 'sell', 'reset']) {
      assert.equal(isSideEffectTool('crypto_paper', { action }), true, action)
    }
  })

  test('classifies trading sub-agent lifecycle actions', () => {
    for (const action of ['status', 'result']) {
      assert.equal(isSideEffectTool('trading_agent', { action }), false, action)
    }
    for (const action of ['start', 'continue', 'cancel']) {
      assert.equal(isSideEffectTool('trading_agent', { action }), true, action)
    }
  })

  test('classifies goal reads separately from state transitions', () => {
    assert.equal(isSideEffectTool('goal', { action: 'get' }), false)
    assert.equal(isSideEffectTool('goal', { action: 'create_self' }), true)
    assert.equal(isSideEffectTool('goal', { action: 'complete' }), true)
    assert.equal(isSideEffectTool('goal', { action: 'report_blocker' }), true)
    assert.equal(isSideEffectTool('goal', { action: 'abandon_self' }), true)
  })

  test('fails closed for unknown tools/actions and covers runtime state mutations', () => {
    assert.equal(isSideEffectTool('unknown_future_tool', {}), true)
    assert.equal(isSideEffectTool('schedule', { action: 'create' }), true)
    assert.equal(isSideEffectTool('qq_conversation', { action: 'open' }), true)
    assert.equal(isSideEffectTool('approval', { action: 'approve' }), true)
    assert.equal(isSideEffectTool('memory', { action: 'mark_disputed' }), true)
    assert.equal(isSideEffectTool('fetch_content', { action: 'future_action' }), true)
  })
})
