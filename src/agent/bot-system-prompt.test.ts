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
    assert.match(prompt, /文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具/)
    assert.match(prompt, /自由活动主线/)
    assert.match(prompt, /群聊半参与/)
    assert.match(prompt, /普通群消息.*不是待办/s)
    assert.match(prompt, /"priority":"high".*"afterRowId".*"throughRowId".*不要跳过前面的群聊/s)
    assert.match(prompt, /curiosity tick.*只.*人工调试/s)
    assert.match(prompt, /群聊只是.*生活.*不是.*全部/s)
    assert.match(prompt, /继续当前兴趣.*开始新兴趣.*pause/s)
    assert.match(prompt, /长期记忆.*重复.*主动整理/s)
    assert.match(prompt, /不要为了整理而反复生成总结/)
    assert.match(prompt, /不要.*等待 tick.*事件队列/s)
    assert.match(prompt, /"event":"inbox_update"/)
    assert.match(prompt, /"readArgs"/)
    assert.doesNotMatch(prompt, /\[inbox 更新 \|/)
    assert.doesNotMatch(prompt, /单条消息 ≤ 500 字/)
    assert.doesNotMatch(prompt, /反例对照/)
  })

  test('keeps progressive-disclosure guidance aligned with the visible tool surface', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [],
      metadata: { groupNames: new Map() },
      selfNumber: 456,
      owner: null,
    })
    const disclosure = prompt.slice(prompt.indexOf('[按需披露]'))
    const lines = disclosure.split('\n')
    const toolboxLine = lines.find((line) => line.startsWith('- toolbox:')) ?? ''

    assert.match(disclosure, /- chat_style:.*直接调用/)
    assert.match(disclosure, /- ai_tone:.*直接调用/)
    assert.match(disclosure, /- journal:.*直接调用/)
    assert.match(disclosure, /- collect_sticker:.*直接调用/)
    assert.doesNotMatch(toolboxLine, /表情包池/)
    assert.equal(lines.filter((line) => line.startsWith('- workspace_bash:')).length, 1)
    assert.equal(lines.filter((line) => line.startsWith('- memory:')).length, 1)
  })
})
