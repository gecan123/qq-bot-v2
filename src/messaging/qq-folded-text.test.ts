import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  planQqFoldedText,
  QQ_FOLDED_NODE_MAX_CHARS,
  QQ_FOLDED_TEXT_MAX_CHARS,
  QQ_FOLDED_TEXT_THRESHOLD_CHARS,
  splitQqFoldedText,
} from './qq-folded-text.js'

const sender = { userId: 10000, nickname: 'Luna' }

describe('planQqFoldedText', () => {
  test('keeps ordinary text at or below the threshold unchanged', () => {
    assert.deepEqual(planQqFoldedText([
      { type: 'text', data: { text: '短'.repeat(QQ_FOLDED_TEXT_THRESHOLD_CHARS) } },
    ], sender), { kind: 'not_applicable' })
  })

  test('turns one long text segment into self-authored forward nodes', () => {
    const first = '第一段。'.repeat(240)
    const second = '第二段。'.repeat(240)
    const text = `${first}\n\n${second}`
    const plan = planQqFoldedText([{ type: 'text', data: { text } }], sender)

    assert.equal(plan.kind, 'folded')
    if (plan.kind !== 'folded') return
    assert.equal(plan.nodes.length, 2)
    assert.deepEqual(plan.nodes.map((node) => node.type), ['node', 'node'])
    assert.deepEqual(plan.nodes.map((node) => node.data.nickname), ['Luna · 1/2', 'Luna · 2/2'])
    const rebuilt = plan.nodes.map((node) => {
      if (!('content' in node.data)) return ''
      const content = node.data.content
      return 'data' in content[0]! ? String(content[0].data.text) : ''
    }).join('')
    assert.equal(rebuilt, text)
  })

  test('does not fold reply or mixed-content messages', () => {
    const longText = { type: 'text', data: { text: '长'.repeat(2_000) } }
    assert.deepEqual(planQqFoldedText([
      { type: 'reply', data: { id: '1' } }, longText,
    ], sender), { kind: 'not_applicable' })
    assert.deepEqual(planQqFoldedText([
      longText, { type: 'image', data: { file: 'base64://abc' } },
    ], sender), { kind: 'not_applicable' })
  })

  test('rejects text beyond the bounded folded-message limit', () => {
    const plan = planQqFoldedText([
      { type: 'text', data: { text: '长'.repeat(QQ_FOLDED_TEXT_MAX_CHARS + 1) } },
    ], sender)
    assert.deepEqual(plan, {
      kind: 'too_long',
      charCount: QQ_FOLDED_TEXT_MAX_CHARS + 1,
      maxChars: QQ_FOLDED_TEXT_MAX_CHARS,
    })
  })
})

test('splitQqFoldedText preserves Unicode text and bounds every node', () => {
  const text = `开头${'🙂'.repeat(QQ_FOLDED_NODE_MAX_CHARS)}。\n\n${'结尾'.repeat(900)}`
  const chunks = splitQqFoldedText(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= QQ_FOLDED_NODE_MAX_CHARS))
})
