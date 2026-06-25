import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildBotSystemPrompt } from './bot-system-prompt.js'

describe('buildBotSystemPrompt', () => {
  test('keeps chat constraints and style details out of the resident system prompt', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: null,
    })

    assert.match(prompt, /你是 Luna/)
    assert.match(prompt, /style global \[constraints\|base\|anti_patterns\|special_cases\]/)
    assert.match(prompt, /send_message/)
    assert.match(prompt, /自由活动主线/)
    assert.match(prompt, /群聊半参与/)
    assert.match(prompt, /普通群消息.*不是待办/s)
    assert.doesNotMatch(prompt, /单条消息 ≤ 500 字/)
    assert.doesNotMatch(prompt, /反例对照/)
  })
})
