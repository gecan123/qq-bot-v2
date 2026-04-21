import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildSystemPrompt } from './agent-session.js'

describe('buildSystemPrompt', () => {
  test('contains persona and instruction in correct sections', () => {
    const result = buildSystemPrompt('我是一只猫', '简洁回复')

    assert.ok(result.includes('[群聊人格基座]'), 'should contain persona section header')
    assert.ok(result.includes('我是一只猫'), 'should contain persona text')
    assert.ok(result.includes('[任务约束]'), 'should contain instruction section header')
    assert.ok(result.includes('简洁回复'), 'should contain instruction text')
  })

  test('does not include dynamic current time header', () => {
    const result = buildSystemPrompt('persona', 'instruction')

    assert.ok(!result.includes('当前时间：'), 'should not include dynamic time header')
  })

  test('persona appears before instruction', () => {
    const result = buildSystemPrompt('PERSONA_MARKER', 'INSTRUCTION_MARKER')

    const personaIndex = result.indexOf('PERSONA_MARKER')
    const instructionIndex = result.indexOf('INSTRUCTION_MARKER')

    assert.ok(personaIndex < instructionIndex, 'persona should appear before instruction')
  })

  test('sections are separated by blank lines', () => {
    const result = buildSystemPrompt('persona', 'instruction')

    assert.ok(result.startsWith('[群聊人格基座]'), 'persona section should be first')
    assert.ok(result.includes('\n\n[任务约束]'), 'blank line before instruction section')
  })
})
