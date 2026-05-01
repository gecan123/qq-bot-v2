import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildSummarizerHistory, SUMMARIZER_TRIGGER_INSTRUCTION } from './summarizer.js'

describe('buildSummarizerHistory', () => {
  test('previous summary 在前, history 在中, trigger 在末', () => {
    const result = buildSummarizerHistory({
      previousSummary: '之前聊了电影。',
      historyToCompress: [
        { role: 'user', content: '用户A: 早' },
        { role: 'model', content: '早。今天聊点啥' },
      ],
    })

    assert.deepEqual(result, [
      { role: 'user', content: '[上次摘要]\n之前聊了电影。' },
      { role: 'user', content: '用户A: 早' },
      { role: 'model', content: '早。今天聊点啥' },
      { role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION },
    ])
  })

  test('没有 previousSummary 时不加 [上次摘要] 前缀', () => {
    const result = buildSummarizerHistory({
      previousSummary: null,
      historyToCompress: [{ role: 'user', content: '用户A: hi' }],
    })

    assert.equal(result.length, 2)
    assert.deepEqual(result[0], { role: 'user', content: '用户A: hi' })
    assert.deepEqual(result[1], { role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })
  })

  test('previousSummary 是空白串时也跳过', () => {
    const result = buildSummarizerHistory({
      previousSummary: '   \n  ',
      historyToCompress: [],
    })

    assert.equal(result.length, 1)
    assert.deepEqual(result[0], { role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })
  })

  test('保留 historyToCompress 的顺序和 role', () => {
    const result = buildSummarizerHistory({
      previousSummary: null,
      historyToCompress: [
        { role: 'user', content: 'A' },
        { role: 'model', content: 'B' },
        { role: 'user', content: 'C' },
        { role: 'model', content: 'D' },
      ],
    })

    assert.equal(result.length, 5)
    assert.deepEqual(
      result.slice(0, 4).map((m) => 'role' in m ? m.role : 'unknown'),
      ['user', 'model', 'user', 'model'],
    )
  })
})
