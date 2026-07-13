import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { interpretToolEffects } from './effect-interpreter.js'

describe('interpretToolEffects', () => {
  test('marks a naturally elapsed pause as a completed rest', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-1',
      toolName: 'pause',
      effect: { type: 'pause', status: 'elapsed' },
    }]), {
      didPause: true,
      didCompleteRest: true,
    })
  })

  test('keeps interrupted and legacy pause effects from requesting a resume reminder', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-1',
      toolName: 'pause',
      effect: { type: 'pause', status: 'interrupted' },
    }]), {
      didPause: true,
      didCompleteRest: false,
    })
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-2',
      toolName: 'pause',
      effect: { type: 'pause' },
    }]), {
      didPause: true,
      didCompleteRest: false,
    })
  })

  test('rejects elapsed pause effects from unrelated tools', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      effect: { type: 'pause', status: 'elapsed' },
    }]), {
      didPause: false,
      didCompleteRest: false,
    })
  })
})
