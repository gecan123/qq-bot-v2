import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildReplyHistory } from './reply-history.js'

describe('buildReplyHistory', () => {
  test('formats context and current message as plain user turns without staged acknowledgements', () => {
    const history = buildReplyHistory('上一轮消息', '@123 你是谁')

    assert.deepEqual(history, [
      { role: 'user', content: '[近期会话背景]\n上一轮消息' },
      { role: 'user', content: '[当前要回复的消息]\n@123 你是谁' },
    ])
  })

  test('falls back to stable degraded markers when content is unavailable', () => {
    const history = buildReplyHistory('', '')
    const [contextMessage, currentMessage] = history

    assert.deepEqual(contextMessage, { role: 'user', content: '[近期会话背景]\n（暂无近期消息记录）' })
    assert.deepEqual(currentMessage?.role, 'user')
    assert.match(currentMessage?.content ?? '', /消息文本暂不可用/)
  })
})
