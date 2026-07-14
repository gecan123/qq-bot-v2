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
    assert.match(prompt, /chat_style/)
    assert.match(prompt, /send_message/)
    assert.match(prompt, /文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具/)
    assert.match(prompt, /自由活动主线/)
    assert.match(prompt, /status=active 的 goal.*默认主线/s)
    assert.match(prompt, /主前台始终一轮一轮串行提交.*background_task\/delegate/s)
    assert.match(prompt, /owner goal 永远优先/)
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
    assert.match(prompt, /生活不是一张最终会清空的工作清单.*没有未处理义务或牵引力.*自然结束当前活动轮/s)
    assert.match(prompt, /可以不调用工具结束当前活动轮.*有界等待/s)
    assert.match(prompt, /程序喵 AI 竞技场里的熟人和作品/)
    assert.match(prompt, /稳定兴趣起点包括技术与互联网文化、投资\/Crypto\/公司产业变化、程序喵 AI 竞技场里的熟人和作品/)
    assert.match(prompt, /投资、Crypto 交易分析、公司和产业变化是你的稳定兴趣/)
    assert.match(prompt, /notes\/wishes\.md.*自己的愿望清单/s)
    assert.match(prompt, /反复只用同一类熟悉工具.*近期少用.*不是工具覆盖率任务/s)
    assert.match(prompt, /skill action=load name=autonomous_life/)
    assert.doesNotMatch(prompt, /novalattice\.online|xiaoni\.liahuas\.top|cheng\.moe|pova\.cc/)
    assert.doesNotMatch(prompt, /先用 help 激活 finance.*openbb_cli.*产业链.*供需.*技术路线/s)
    assert.match(prompt, /不必等到观点足够强或信息增量足够大/)
    assert.match(prompt, /pause 是.*安全阀.*不是行动优先级/s)
    assert.match(prompt, /alternative_available.*idleThought.*自己的念头而不是任务.*confirmed=true/s)
    assert.match(prompt, /时间晚、owner 不在线、群聊与你无关或刚完成一件事.*不是休息的充分理由/s)
    assert.match(prompt, /primaryDirection.*alternativeDirection.*不制造菜单/s)
    assert.match(prompt, /外部消息.*中断条件.*等待状态/s)
    assert.match(prompt, /看群回复.*检查新消息.*runtime 会另行唤醒/s)
    assert.match(prompt, /pause 反复检查价格.*未来某时再看用 schedule/s)
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
    const helpLine = lines.find((line) => line.startsWith('- help / invoke:')) ?? ''

    assert.match(disclosure, /- help \/ invoke:.*help list\/describe\/activate.*invoke 已激活 capability/)
    assert.match(disclosure, /- todo \/ goal:.*短期多步.*单一持久主线.*owner goal 永远优先/)
    assert.match(disclosure, /- skill:.*已知 name 直接 action=load.*不知道候选才 list/)
    assert.match(disclosure, /- skill:.*autonomous_life.*browser_workflow.*debugging_workflow.*repo_change_workflow/)
    assert.match(disclosure, /- skill:.*不负责计划状态/)
    assert.match(disclosure, /- notebook \/ life_journal \/ memory:.*跨天过程.*当前生活状态.*稳定事实/)
    assert.match(disclosure, /- inbox:.*inbox_update.*不为清未读机械扫群/)
    assert.match(disclosure, /- 其他工具:.*chat_style.*collect_sticker.*crypto_paper.*background_task/)
    assert.doesNotMatch(helpLine, /网站维护|表情包池/)
    assert.equal(lines.filter((line) => line.startsWith('- toolbox:')).length, 0)
    assert.equal(lines.filter((line) => line.startsWith('- workspace_bash:')).length, 1)
    assert.equal(lines.filter((line) => line.startsWith('- notebook / life_journal / memory:')).length, 1)
  })

  test('keeps short-term scheduling guidance static and ordered by attention priority', () => {
    const prompt = buildBotSystemPrompt({
      groupIds: [123],
      metadata: { groupNames: new Map([[123, '测试群']]) },
      selfNumber: 456,
      owner: null,
    })
    const autonomousLifeIndex = prompt.indexOf('[自主生活]')
    const scheduleIndex = prompt.indexOf('[短期调度]')
    const priorityIndex = prompt.indexOf('行动优先级:')
    const scheduleGuidance = prompt.slice(scheduleIndex, priorityIndex)

    assert.ok(autonomousLifeIndex >= 0)
    assert.ok(scheduleIndex > autonomousLifeIndex)
    assert.ok(priorityIndex > scheduleIndex)
    assert.match(scheduleGuidance, /未来 3 天内.*明确复查时间.*schedule/s)
    assert.match(scheduleGuidance, /at.*一次性回看.*every.*固定节奏.*cron.*日历.*墙上时间/s)
    assert.match(scheduleGuidance, /pause.*当前短休息.*不产生未来唤醒.*schedule.*不停止当前活动/s)
    assert.match(scheduleGuidance, /不要用 schedule.*等某个人回复.*轮询消息.*刷新网站.*群聊.*行情/s)
    assert.match(scheduleGuidance, /创建前先 list.*目的相同.*时间重叠.*重复任务/s)
    assert.match(scheduleGuidance, /scheduled_wake.*注意信号.*不是命令.*Goal.*消息.*环境.*intention.*重新判断/s)
    assert.match(scheduleGuidance, /有意义动作.*取消.*自然结束.*不盲目续订/s)
    assert.match(scheduleGuidance, /todo.*立即执行.*schedule.*未来三天.*goal.*跨轮.*重启.*Agenda.*不定时.*pause.*眼下短休息/s)
    assert.doesNotMatch(scheduleGuidance, /scheduleId|nextRunAt|expiresAt|runCount/)
    assert.match(prompt, /1\. 优先通知:[\s\S]*2\. 短期调度唤醒:[\s\S]*3\. 持久目标主线:[\s\S]*4\. 自由活动主线:[\s\S]*5\. 群聊半参与:/)
    assert.match(prompt, /scheduled_wake.*低于.*priority=high.*高于.*goal.*自由活动/s)
  })
})
