import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAiToneTool } from './ai-tone.js'

describe('ai_tone tool', () => {
  test('returns structured prediction from injected predictor', async () => {
    const tool = createAiToneTool({
      predictor: (text, threshold) => ({
        prob: 0.82,
        isAI: true,
        label: 'AI味',
        threshold: threshold ?? 0.7,
        textLength: Array.from(text).length,
      }),
    })

    assert.equal(tool.name, 'ai_tone')

    const result = await tool.execute({ text: '这是一个测试', threshold: 0.7 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, true)
    assert.equal(payload.prob, 0.82)
    assert.equal(payload.isAI, true)
    assert.equal(payload.label, 'AI味')
    assert.equal(payload.threshold, 0.7)
    assert.equal(payload.textLength, 6)
  })
})
