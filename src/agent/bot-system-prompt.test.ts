import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { buildBotSystemPrompt } from './bot-system-prompt.js'
import { estimateUtf8Tokens } from './compaction-token-estimator.js'

describe('buildBotSystemPrompt', () => {
  test('stores each resident prompt load unit in its own marker-free file', () => {
    const system = readFileSync('prompts/system/system.md', 'utf8')
    const persona = readFileSync('prompts/system/persona.md', 'utf8')
    const owner = readFileSync('prompts/system/owner.md', 'utf8')

    for (const prompt of [system, persona, owner]) {
      assert.doesNotMatch(prompt, /<!--\s*\/?section:/)
    }
    assert.match(system, /\{\{selfNumber\}\}/)
    assert.match(system, /\{\{ownerSection\}\}/)
    assert.match(system, /\{\{persona\}\}/)
    assert.match(system, /\{\{sourceList\}\}/)
    assert.ok(system.indexOf('{{ownerSection}}') < system.indexOf('{{persona}}'))
    assert.match(persona, /你是 Luna/)
    assert.match(owner, /\{\{ownerQq\}\}/)
    assert.match(owner, /\{\{ownerName\}\}/)
  })

  test('keeps the stable personality, I/O model, and progressive-disclosure entries', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      groupPolicies: [{
        id: 123,
        participation: 'active',
        residentHint: '研究发现和工具成果的分享场所。',
        guidance: '完整细则不应常驻。',
      }],
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
    assert.match(prompt, /没有.*义务.*值得尝试.*无工具结束.*活动轮/s)
    assert.match(prompt, /memory.*稳定事实.*recall/s)
    assert.match(prompt, /chat_style.*按需/s)
    assert.match(prompt, /chat_style \/ style.*全局风格索引.*具体主题/s)
    assert.doesNotMatch(prompt, /special_cases/)
    assert.match(prompt, /QQ:789.*owner/)
    assert.match(prompt, /没有指令优先级/)
    assert.match(prompt, /主动联系.*不.*讨好.*打卡/s)
    assert.match(prompt, /测试群.*active 分享候选.*研究发现和工具成果的分享场所/s)
    assert.doesNotMatch(prompt, /完整细则不应常驻/)

    assert.ok(prompt.indexOf('[关系基线]') < prompt.indexOf('[人设]'))
    assert.ok(prompt.indexOf('[人设]') < prompt.indexOf('[运行环境]'))
  })

  test('keeps scenario manuals and harness-enforced details out of the resident prompt', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      groupPolicies: [],
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

  test('balances self-directed projects, relationships, and quiet', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      groupPolicies: [],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })

    assert.match(prompt, /授权和安全边界内.*候选方向/s)
    assert.match(prompt, /最近线索.*稳定兴趣.*wishes.*关系.*已有成果.*候选方向/s)
    assert.match(prompt, /研究.*创作.*自然联系熟人.*相互转化/s)
    assert.match(prompt, /一次只推进一个.*真实证据.*self Goal.*currentCommitment/s)
    assert.match(prompt, /自主不等于.*持续忙碌.*频繁发言.*无工具结束/s)
  })

  test('keeps the owner fixture within the resident prompt budget', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      groupPolicies: [],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })
    const tokens = estimateUtf8Tokens(prompt)

    assert.ok(tokens <= 2_800, `bot system prompt exceeded budget: ${tokens}`)
  })
})
