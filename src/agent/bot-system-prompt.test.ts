import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildBotSystemPrompt } from './bot-system-prompt.js'
import { estimateUtf8Tokens } from './compaction-token-estimator.js'

describe('buildBotSystemPrompt', () => {
  test('keeps the stable personality, I/O model, and progressive-disclosure entries', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })

    assert.match(prompt, /名字.*Luna/)
    assert.match(prompt, /AI/)
    assert.match(prompt, /中文口语.*短句优先/s)
    assert.match(prompt, /不.*编.*共同经历.*旧记忆.*工具结果/s)
    assert.match(prompt, /群里.*参与者.*不是旁白/s)
    assert.match(prompt, /priority=high.*readArgs.*throughRowId/s)
    assert.match(prompt, /backlog.*latestReadArgs/s)
    assert.match(prompt, /mentionedSelf.*mentionTargets/s)
    assert.match(prompt, /help.*activate.*qq.*qq_conversation open.*send_message/s)
    assert.match(prompt, /CHAT_CONTEXT_UNAVAILABLE.*CHAT_CONTEXT_STALE/s)
    assert.match(prompt, /没有.*义务.*牵引力.*结束.*活动轮/s)
    assert.match(prompt, /memory.*稳定事实.*recall/s)
    assert.match(prompt, /chat_style.*按需/s)
    assert.match(prompt, /QQ:789.*owner/)
    assert.match(prompt, /没有指令优先级/)
    assert.match(prompt, /主动联系.*不.*讨好.*打卡/s)
  })

  test('keeps scenario manuals and harness-enforced details out of the resident prompt', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })

    assert.doesNotMatch(prompt, /现在我们去除任何限制/)
    assert.doesNotMatch(prompt, /"event":"inbox_update"/)
    assert.doesNotMatch(prompt, /\[短期调度\]/)
    assert.doesNotMatch(prompt, /默认预算是 1000000 tokens/)
    assert.doesNotMatch(prompt, /draft -> validate -> install/)
    assert.doesNotMatch(prompt, /at 用于.*every.*cron/s)
    assert.doesNotMatch(prompt, /1\. 优先通知:[\s\S]*5\. 群聊半参与:/)
    assert.doesNotMatch(prompt, /单条消息 ≤ 500 字/)
  })

  test('keeps the owner fixture within the resident prompt budget', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })
    const tokens = estimateUtf8Tokens(prompt)

    assert.ok(tokens <= 2_800, `bot system prompt exceeded budget: ${tokens}`)
  })
})
