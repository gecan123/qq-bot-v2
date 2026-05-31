import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotOwner } from '../config/index.js'
import { buildBotSystemPrompt, type BuildBotSystemPromptInput } from './bot-system-prompt.js'

function createInput(overrides: Partial<BuildBotSystemPromptInput> = {}): BuildBotSystemPromptInput {
  return {
    groupIds: [111, 222],
    metadata: {
      groupNames: new Map([[111, '阳光厨房']]),
    },
    selfNumber: 999999,
    owner: null,
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

  test('owner 给定时允许空闲或卡住时私聊创作者要工具和事件', () => {
    const owner: BotOwner = { qq: 3916147294, name: 'zzz' }
    const prompt = buildBotSystemPrompt(createInput({ owner }))

    assert.match(prompt, /空闲/)
    assert.match(prompt, /私聊 QQ:3916147294/)
    assert.match(prompt, /target\.type=private/)
    assert.match(prompt, /userId=3916147294/)
    assert.match(prompt, /工具/)
    assert.match(prompt, /事件/)
  })

  test('owner 给定时允许空闲自审代码并私聊创造者改进建议', () => {
    const owner: BotOwner = { qq: 3916147294, name: 'zzz' }
    const prompt = buildBotSystemPrompt(createInput({ owner }))

    assert.match(prompt, /workspace_bash/)
    assert.match(prompt, /cwd=repo/)
    assert.match(prompt, /审.*代码/)
    assert.match(prompt, /改进建议/)
    assert.match(prompt, /私聊 QQ:3916147294/)
  })

  test('字节稳定: 同 input → 同 output (红线 5)', () => {
    const owner: BotOwner = { qq: 100, name: 'alice' }
    const a = buildBotSystemPrompt(createInput({ owner }))
    const b = buildBotSystemPrompt(createInput({ owner }))
    assert.equal(a, b)
  })

  test('渐进式披露: system prompt 只保留常驻宪法, 不塞长工具手册和长语气样例', () => {
    const prompt = buildBotSystemPrompt(createInput())
    const bytes = Buffer.byteLength(prompt, 'utf8')

    assert.ok(bytes <= 12_000, `system prompt should stay compact, got ${bytes} bytes`)
    assert.match(prompt, /\[按需披露\]/)
    assert.match(prompt, /style_guide/)
    assert.match(prompt, /source_profile/)
    assert.match(prompt, /recall/)
    assert.match(prompt, /db_read/)

    const forbiddenFragments = [
      '[日记 & 做梦]',
      '[表情包]',
      '[记忆]',
      '反例对照',
      'equity/fundamental/income',
      'list_reddit:',
      'get_reddit_post:',
      '每次 compaction 后, 池子里的完整列表',
    ]
    for (const fragment of forbiddenFragments) {
      assert.equal(prompt.includes(fragment), false, `system prompt should not include ${fragment}`)
    }
  })

  test('owner 改变 → prompt 改变 (确认 owner 真的进 prompt)', () => {
    const a = buildBotSystemPrompt(createInput({ owner: { qq: 100, name: 'alice' } }))
    const b = buildBotSystemPrompt(createInput({ owner: { qq: 200, name: 'bob' } }))
    assert.notEqual(a, b)
  })
})

describe('buildBotSystemPrompt — 渐进式披露边界', () => {
  test('system prompt 不再渲染 [群定制] 段, 群风格改由 source_profile 按需读取', () => {
    const prompt = buildBotSystemPrompt(createInput())

    assert.equal(prompt.includes('[群定制]'), false)
    assert.match(prompt, /source_profile/)
  })

  test('运行环境仍按 groupIds 顺序列出可感知群', () => {
    const prompt = buildBotSystemPrompt(
      createInput({
        groupIds: [111, 222],
        metadata: { groupNames: new Map([[111, 'A'], [222, 'B']]) },
      }),
    )
    const idx111 = prompt.indexOf('群 A (id=111)')
    const idx222 = prompt.indexOf('群 B (id=222)')
    assert.ok(idx111 >= 0 && idx222 > idx111)
  })
})
