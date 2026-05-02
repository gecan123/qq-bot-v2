import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { extractTriggerText } from './context-builder.js'

describe('extractTriggerText', () => {
  test('忽略 reply 段, 只输出文本+特殊段的可读形式', () => {
    const text = extractTriggerText([
      { type: 'reply', messageId: '42' },
      { type: 'text', content: '@bot 你好' },
    ])
    assert.match(text, /@bot 你好/)
  })

  test('全是 reply 段时返回空串 trim 后', () => {
    const text = extractTriggerText([{ type: 'reply', messageId: '1' }])
    assert.equal(text.trim(), '')
  })
})
