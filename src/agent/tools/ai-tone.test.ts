import assert from 'node:assert/strict'
import { test } from 'node:test'
import { predictAiTone } from './ai-tone.js'

test('predictAiTone returns a bounded style hint for the send hook', () => {
  const result = predictAiTone('这是一个测试', 0.7)
  assert.equal(result.threshold, 0.7)
  assert.equal(result.textLength, 6)
  assert.equal(result.prob >= 0 && result.prob <= 1, true)
  assert.equal(result.label, result.isAI ? 'AI味' : '人味')
})
