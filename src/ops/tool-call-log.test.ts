import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isSideEffectTool } from './tool-call-log.js'

describe('tool-call-log side effect classification', () => {
  test('classifies Moomoo reads separately from simulated trading writes', () => {
    for (const command of [
      'moomoo check_env',
      'moomoo quote/get_snapshot US.AAPL',
      'moomoo trade/get_portfolio --trd-env SIMULATE',
    ]) {
      assert.equal(isSideEffectTool('workspace_bash', { command }), false, command)
    }

    for (const command of [
      'moomoo trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
      'moomoo trade/modify_order --order-id 123 --price 101 --trd-env SIMULATE',
      'moomoo trade/cancel_order --order-id 123 --trd-env SIMULATE',
      'moomoo unknown',
    ]) {
      assert.equal(isSideEffectTool('workspace_bash', { command }), true, command)
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
})
