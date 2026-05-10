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
