import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotOwner } from '../config/index.js'
import type { GroupCustomization } from '../config/group-prompts.js'
import { buildBotSystemPrompt, type BuildBotSystemPromptInput } from './bot-system-prompt.js'

function createInput(overrides: Partial<BuildBotSystemPromptInput> = {}): BuildBotSystemPromptInput {
  return {
    groupIds: [111, 222],
    metadata: {
      groupNames: new Map([[111, '阳光厨房']]),
    },
    selfNumber: 999999,
    owner: null,
    groupCustomizations: [],
    ...overrides,
  }
}

describe('buildBotSystemPrompt', () => {
  test('owner=null 时不渲染 [关系基线] 段', () => {
    const prompt = buildBotSystemPrompt(createInput({ owner: null }))
    assert.equal(prompt.includes('[关系基线'), false)
    assert.equal(prompt.includes('把你做出来的人'), false)
  })

  test('owner 给定时渲染 [关系基线] 段, 含 QQ 和 name', () => {
    const owner: BotOwner = { qq: 3916147294, name: 'zzz' }
    const prompt = buildBotSystemPrompt(createInput({ owner }))
    assert.match(prompt, /\[关系基线 — 硬事实\]/)
    assert.match(prompt, /QQ:3916147294 这个号是 zzz/)
    assert.match(prompt, /把你做出来的人/)
  })

  test('owner 段位于 [身份] 后, [人设基座] 前', () => {
    const owner: BotOwner = { qq: 100, name: 'alice' }
    const prompt = buildBotSystemPrompt(createInput({ owner }))
    const idxIdentity = prompt.indexOf('[身份 — 硬事实')
    const idxOwner = prompt.indexOf('[关系基线')
    const idxPersona = prompt.indexOf('[人设基座]')
    assert.ok(idxIdentity >= 0 && idxOwner > idxIdentity && idxPersona > idxOwner,
      `expected order: 身份 < 关系基线 < 人设基座, got ${idxIdentity}, ${idxOwner}, ${idxPersona}`)
  })

  test('owner prompt 强调不是上司 / 没有指令优先级 (anti-sycophancy)', () => {
    const owner: BotOwner = { qq: 1, name: 'x' }
    const prompt = buildBotSystemPrompt(createInput({ owner }))
    assert.match(prompt, /不是上司/)
    assert.match(prompt, /没有指令优先级/)
  })

  test('字节稳定: 同 input → 同 output (红线 5)', () => {
    const owner: BotOwner = { qq: 100, name: 'alice' }
    const a = buildBotSystemPrompt(createInput({ owner }))
    const b = buildBotSystemPrompt(createInput({ owner }))
    assert.equal(a, b)
  })

  test('owner 改变 → prompt 改变 (确认 owner 真的进 prompt)', () => {
    const a = buildBotSystemPrompt(createInput({ owner: { qq: 100, name: 'alice' } }))
    const b = buildBotSystemPrompt(createInput({ owner: { qq: 200, name: 'bob' } }))
    assert.notEqual(a, b)
  })
})

describe('buildBotSystemPrompt — [群定制] 段', () => {
  test('groupCustomizations=[] → 不渲染 [群定制] 段', () => {
    const prompt = buildBotSystemPrompt(createInput({ groupCustomizations: [] }))
    assert.equal(prompt.includes('[群定制]'), false)
  })

  test('groupIds=[111, 222], yaml 只配 111 → [群定制] 含 111 不含 222', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'chatty', body: '聊吃的群' },
    ]
    const prompt = buildBotSystemPrompt(createInput({ groupCustomizations: customs }))
    assert.match(prompt, /\[群定制\]/)
    assert.match(prompt, /群 阳光厨房 \(id=111\) — 节奏: 主动 \(chatty\)/)
    assert.match(prompt, /聊吃的群/)
    assert.equal(prompt.includes('id=222) — 节奏'), false)
  })

  test('groupIds 顺序决定渲染顺序 (deterministic, 不按 yaml 顺序)', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'chatty', body: '' },
      { id: 222, frequencyHint: 'quiet', body: '' },
    ]
    const promptA = buildBotSystemPrompt(
      createInput({
        groupIds: [111, 222],
        metadata: { groupNames: new Map([[111, 'A'], [222, 'B']]) },
        groupCustomizations: customs,
      }),
    )
    const promptB = buildBotSystemPrompt(
      createInput({
        groupIds: [222, 111],
        metadata: { groupNames: new Map([[111, 'A'], [222, 'B']]) },
        // yaml 顺序故意倒过来, 不应影响输出
        groupCustomizations: [customs[1], customs[0]],
      }),
    )
    const idxA111 = promptA.indexOf('id=111')
    const idxA222 = promptA.indexOf('id=222')
    const idxB111 = promptB.indexOf('id=111')
    const idxB222 = promptB.indexOf('id=222')
    assert.ok(idxA111 < idxA222, 'groupIds=[111,222] → 111 在前')
    assert.ok(idxB222 < idxB111, 'groupIds=[222,111] → 222 在前')
  })

  test('body 为空字符串 → 只渲染 header 行, 不渲染缩进 body', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'normal', body: '' },
    ]
    const prompt = buildBotSystemPrompt(createInput({ groupCustomizations: customs }))
    const groupSegStart = prompt.indexOf('[群定制]')
    const groupSegEnd = prompt.indexOf('[消息标签格式]')
    const groupSeg = prompt.slice(groupSegStart, groupSegEnd)
    assert.match(groupSeg, /群 阳光厨房 \(id=111\) — 节奏: 默认 \(normal\)/)
    // body 为空时该群只有 1 行 header, 后面紧跟 (这里因为只有 1 个群也无后续)
    // 检查 header 之后没有缩进 2 空格的内容行
    const lines = groupSeg.split('\n')
    const headerIdx = lines.findIndex((l) => l.includes('id=111'))
    const next = lines[headerIdx + 1] ?? ''
    assert.equal(next.startsWith('  '), false, `header 之后不应有缩进 body 行, got: ${JSON.stringify(next)}`)
  })

  test('metadata 没有该群名 → 用 id 替代群名', () => {
    const customs: GroupCustomization[] = [
      { id: 999, frequencyHint: 'normal', body: '' },
    ]
    const prompt = buildBotSystemPrompt(
      createInput({
        groupIds: [999],
        metadata: { groupNames: new Map() },
        groupCustomizations: customs,
      }),
    )
    assert.match(prompt, /群 999 \(id=999\)/)
  })

  test('byte-identical: customizations=[] 时 prompt 字节等于无该参数时的 baseline (锚红线 5)', () => {
    // baseline: 用未引入 [群定制] 段时的等价 input. 因为 createInput 已默认
    // groupCustomizations: [], 所以 baseline 跟传 [] 应当字节相等. 这个测试锁住:
    // 加 [群定制] 特性后, 当 customizations=[] 时 byte-identical 不变.
    const baseline = buildBotSystemPrompt(createInput())
    const withEmpty = buildBotSystemPrompt(createInput({ groupCustomizations: [] }))
    assert.equal(baseline, withEmpty)
    // 同时确认 baseline 不含 [群定制] 标识 (回归保护)
    assert.equal(baseline.includes('[群定制]'), false)
  })

  test('yaml 配了一个不在 groupIds 里的 id → 静默忽略 (不渲染该项)', () => {
    const customs: GroupCustomization[] = [
      { id: 999, frequencyHint: 'chatty', body: 'whitelist 外' },
    ]
    const prompt = buildBotSystemPrompt(
      createInput({ groupIds: [111], groupCustomizations: customs }),
    )
    // 999 不在 groupIds, 不应出现在 [群定制] 段
    // (但是没有匹配项时 [群定制] 段整体不渲染)
    assert.equal(prompt.includes('id=999'), false)
    assert.equal(prompt.includes('whitelist 外'), false)
    assert.equal(prompt.includes('[群定制]'), false)
  })

  test('多行 body 每行都被缩进 2 空格', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'chatty', body: '第一行\n第二行\n第三行' },
    ]
    const prompt = buildBotSystemPrompt(createInput({ groupCustomizations: customs }))
    assert.match(prompt, /  第一行/)
    assert.match(prompt, /  第二行/)
    assert.match(prompt, /  第三行/)
  })

  test('[群定制] 段在 [运行环境] 之后, [消息标签格式] 之前', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'normal', body: '' },
    ]
    const prompt = buildBotSystemPrompt(createInput({ groupCustomizations: customs }))
    const idxEnv = prompt.indexOf('[运行环境')
    const idxGroup = prompt.indexOf('[群定制]')
    const idxTag = prompt.indexOf('[消息标签格式]')
    assert.ok(
      idxEnv >= 0 && idxGroup > idxEnv && idxTag > idxGroup,
      `期望 [运行环境] < [群定制] < [消息标签格式], got ${idxEnv}, ${idxGroup}, ${idxTag}`,
    )
  })

  test('frequency_hint 4 档说明在 [群定制] 段里出现, 且只一次 (不在每个群下重复)', () => {
    const customs: GroupCustomization[] = [
      { id: 111, frequencyHint: 'chatty', body: '' },
      { id: 222, frequencyHint: 'quiet', body: '' },
    ]
    const prompt = buildBotSystemPrompt(
      createInput({
        groupIds: [111, 222],
        metadata: { groupNames: new Map([[111, 'A'], [222, 'B']]) },
        groupCustomizations: customs,
      }),
    )
    // "节奏 4 档:" 文案只出现 1 次 (说明放在 [群定制] header 区, 不在每群下重复)
    const occurrences = prompt.split('节奏 4 档:').length - 1
    assert.equal(occurrences, 1)
  })
})
