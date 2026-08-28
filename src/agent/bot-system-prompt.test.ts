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
    assert.match(prompt, /不含正文的 `notification`.*open\.tool.*open\.args/s)
    assert.match(prompt, /delivery=interrupt.*passive.*priority/s)
    assert.match(prompt, /high\+interrupt.*normal\+passive/s)
    assert.match(prompt, /throughRowId.*backlog.*data\.readArgs/s)
    assert.match(prompt, /mentionedSelf.*mentionTargets/s)
    assert.match(prompt, /help describe.*conversation open.*send_message/s)
    assert.match(prompt, /CHAT_CONTEXT_UNAVAILABLE.*CHAT_CONTEXT_STALE/s)
    assert.match(prompt, /send_message\.work.*当前会话内马上继续/s)
    assert.match(prompt, /无承诺用 none.*有则用 continue/s)
    assert.match(prompt, /只输出文本.*不调工具.*runtime 纠错/s)
    assert.match(prompt, /有具体牵引力.*持续生活和行动.*一次有界方向搜索.*有就开始.*没有就停/s)
    assert.match(prompt, /重复检查.*重复发布.*为了证明忙碌.*直接用 `rest` 闲下来/s)
    assert.match(prompt, /换了题目.*同一种批量生产.*重读.*删减.*修改/s)
    assert.match(prompt, /程序喵 AI 竞技场.*zzz.*小镜.*小伊.*一个具体问题.*不同时广播.*收到反馈.*继续修改/s)
    assert.match(prompt, /明确获得乐趣.*投入.*好奇.*self\/topic Memory/s)
    assert.match(prompt, /`rest`.*范围 10\.\.30.*60 分钟.*不要再次调用/s)
    assert.match(prompt, /Schedule.*不会披露剩余时间/s)
    assert.match(prompt, /未来提醒.*信任.*不要在提醒前反复检查/s)
    assert.match(prompt, /browser \/ NGA.*persistent profile.*NGA 登录态.*自行打开.*刷帖.*读楼/s)
    assert.match(prompt, /crypto_paper decisionSource=self.*BTC\/ETH\/SOL.*权益 5%.*权益 20%.*普通证券/s)
    assert.match(prompt, /先歇着.*psychologist.*hasNegative=true.*rewritten/s)
    assert.match(prompt, /memory.*稳定事实.*recall/s)
    assert.match(prompt, /chat_style.*按需/s)
    assert.match(prompt, /chat_style \/ style.*全局风格索引.*具体主题/s)
    assert.match(prompt, /Luna 的自留地.*长期创作空间.*help.*website.*status.*read.*现有文章.*revision.*publish/s)
    assert.match(prompt, /publish 成功.*Git 已推送.*不代表 Vercel 已部署.*正式页面.*已上线/s)
    assert.match(prompt, /不要为制造进展.*机械改动.*空内容/s)
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

  test('keeps self-directed work continuous without turning it into mechanical activity', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      groupPolicies: [],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: { qq: 789, name: 'owner' },
    })

    assert.match(prompt, /授权和安全边界内.*候选方向/s)
    assert.match(prompt, /最近线索.*稳定兴趣.*关系.*已有成果.*候选方向/s)
    assert.match(prompt, /研究.*创作.*自然联系熟人.*相互转化/s)
    assert.match(prompt, /一次只推进一个.*真实证据.*continue.*Notebook.*Schedule/s)
    assert.match(prompt, /不要.*承诺.*我会继续.*continue 发送后.*下一步/s)
    assert.match(prompt, /后台任务运行时.*切换去做别的事情/s)
    assert.match(prompt, /每个活动轮.*真实工具调用.*不能用空白.*assistant 文本收尾/s)
    assert.match(prompt, /持续运行不等于.*频繁发言.*机械清空群聊.*Journal/s)
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
