import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildReplyHistory } from './reply-history.js'

describe('buildReplyHistory', () => {
  test('Phase 1.5: 多轮签名串联 summary, window history (含 model role), trigger', () => {
    const history = buildReplyHistory({
      windowHistory: [
        { role: 'user', content: '用户A: 早上好' },
        { role: 'model', content: '早。今天聊点啥' },
        { role: 'user', content: '用户A: 那聊聊电影' },
      ],
      compactedSummary: '昨天讨论过几部老电影。',
      trigger: '@bot 你最近看什么了',
    })

    assert.deepEqual(history, [
      { role: 'user', content: '[历史摘要]\n昨天讨论过几部老电影。' },
      { role: 'user', content: '用户A: 早上好' },
      { role: 'model', content: '早。今天聊点啥' },
      { role: 'user', content: '用户A: 那聊聊电影' },
      { role: 'user', content: '[当前要回复的消息]\n@bot 你最近看什么了' },
    ])
  })

  test('Phase 1.5: 多轮签名 - 无 summary 时 prefix 干净, 只剩 window 和 trigger', () => {
    const history = buildReplyHistory({
      windowHistory: [{ role: 'user', content: '用户A: hi' }],
      trigger: 'ping',
    })

    assert.deepEqual(history, [
      { role: 'user', content: '用户A: hi' },
      { role: 'user', content: '[当前要回复的消息]\nping' },
    ])
  })

  test('Phase 1.5: 多轮签名 trigger 缺失时降级标记', () => {
    const history = buildReplyHistory({
      windowHistory: [],
      trigger: '',
    })

    assert.equal(history.length, 1)
    const first = history[0]
    assert.ok(first && first.role === 'user')
    assert.match(first.content, /消息文本暂不可用/)
  })
})
