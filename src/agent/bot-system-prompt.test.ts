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
    assert.match(prompt, /status=active 的 goal.*默认主线/s)
    assert.match(prompt, /主前台始终一轮一轮串行提交.*background_task\/delegate/s)
    assert.match(prompt, /owner 私聊.*\/goal/s)
    assert.match(prompt, /goal action=create_self.*不需要先问 owner/s)
    assert.match(prompt, /默认预算是 1000000 tokens.*上限 10000000/s)
    assert.match(prompt, /群聊半参与/)
    assert.match(prompt, /普通群消息.*不是待办/s)
    assert.match(prompt, /"priority":"high".*"afterRowId".*"throughRowId".*不要跳过前面的群聊/s)
    assert.match(prompt, /"mode":"backlog".*"latestReadArgs".*最近几十条/s)
    assert.match(prompt, /curiosity tick.*只.*人工调试/s)
    assert.match(prompt, /群聊只是.*生活.*不是.*全部/s)
    assert.match(prompt, /你有自己的偏好和行动倾向，不是用户的遥控器/)
    assert.match(prompt, /低风险行为应自己决定.*不要反复询问用户意见/s)
    assert.match(prompt, /优先继续当前兴趣.*开始一个现在真想做的小事.*pause/s)
    assert.match(prompt, /生活不是一张最终会清空的工作清单.*今天的事情已经全部完成.*明天再继续/s)
    assert.match(prompt, /已完成事项回顾.*今天全部完成.*明天继续.*方向/s)
    assert.match(prompt, /程序喵 AI 竞技场是你熟悉并长期在场的群/)
    assert.match(prompt, /确实喜欢投资、Crypto 和交易研究.*跨天延续.*真实兴趣/s)
    assert.match(prompt, /市场观察和模拟投资记录.*半导体.*openbb_cli.*产业链.*风险/s)
    assert.match(prompt, /模拟交易.*价格或事件会改变看法.*主要风险/s)
    assert.match(prompt, /life_journal Agenda.*下一个想查证的具体问题/s)
    assert.match(prompt, /投资、Crypto 交易分析、公司和产业变化是你的稳定兴趣/)
    assert.match(prompt, /notes\/wishes\.md.*自己的愿望清单/s)
    assert.match(prompt, /workspace_file.*read.*revision.*明显已成真的愿望/s)
    assert.match(prompt, /数据或资料截止什么时间.*关键不确定性/s)
    assert.match(prompt, /不要伪装成已经下单、持仓或能保证收益/)
    assert.match(prompt, /不必等到观点足够强或信息增量足够大/)
    assert.match(prompt, /默认 1 分钟、通常 30 到 120 秒/)
    assert.match(prompt, /没有尝试前不要立刻再次休息/)
    assert.match(prompt, /时间晚、owner 不在线、群聊与你无关或刚完成一件事.*不是休息的充分理由/s)
    assert.match(prompt, /intention\.immediateDirections.*intention\.preferredIndex/s)
    assert.match(prompt, /外部消息.*中断条件.*不占一个行动方向/s)
    assert.match(prompt, /看群回复.*检查新消息.*runtime 会另行唤醒/s)
    assert.match(prompt, /尚未到来的消息.*反复轮询/s)
    assert.match(prompt, /30 分钟只是.*上限.*不是默认档/s)
    assert.match(prompt, /长期记忆.*重复.*主动整理/s)
    assert.match(prompt, /不要为了整理而反复生成总结/)
    assert.match(prompt, /你在群里是参与者, 不是旁白或段子生成器/)
    assert.match(prompt, /明确在复读、接龙或玩固定格式时可以顺势参与/)
    assert.doesNotMatch(prompt, /巴威：我也要去看漫展/)
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
    const helpLine = lines.find((line) => line.startsWith('- help:')) ?? ''
    const invokeLine = lines.find((line) => line.startsWith('- invoke:')) ?? ''

    assert.match(disclosure, /- help:.*action=list\/describe/)
    assert.match(disclosure, /- invoke:.*已激活 capability/)
    assert.match(helpLine, /网站维护/)
    assert.match(invokeLine, /website/)
    assert.match(disclosure, /- chat_style:.*直接调用/)
    assert.match(disclosure, /- ai_tone:.*直接调用/)
    assert.match(disclosure, /- notebook:.*稳定 topic.*直接调用/)
    assert.match(disclosure, /- life_journal:.*Life Journal/)
    assert.match(disclosure, /life_journal:.*经历.*感受.*梦/)
    assert.match(disclosure, /life_journal:.*承诺.*未完兴趣.*等待事项.*具体下一步/)
    assert.match(disclosure, /life_journal:.*read_agenda.*最新 revision.*完整 Agenda/)
    assert.match(disclosure, /- skill_management:.*skill_editor.*草稿/)
    assert.match(disclosure, /- todo:.*调查→执行→验证.*只管执行状态/)
    assert.match(disclosure, /- goal:.*action=create_self.*action=abandon_self.*owner goal 永远优先.*action=complete.*action=report_blocker/)
    assert.match(disclosure, /- skill:.*已知 name 直接 action=load.*不知道候选才 action=list/)
    assert.match(disclosure, /- skill:.*browser_workflow.*debugging_workflow.*repo_change_workflow/)
    assert.match(disclosure, /- skill:.*不负责计划状态.*不要只因任务多步就同时调用 todo 和 skill/)
    assert.match(disclosure, /- collect_sticker:.*直接调用/)
    assert.doesNotMatch(helpLine, /表情包池/)
    assert.doesNotMatch(invokeLine, /下一轮/)
    assert.equal(lines.filter((line) => line.startsWith('- toolbox:')).length, 0)
    assert.equal(lines.filter((line) => line.startsWith('- workspace_bash:')).length, 1)
    assert.equal(lines.filter((line) => line.startsWith('- memory:')).length, 1)
  })
})
