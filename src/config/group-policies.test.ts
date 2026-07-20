import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  groupPolicyAllowsAmbient,
  parseGroupPoliciesMarkdown,
} from './group-policies.js'

describe('group policies', () => {
  test('parses readable Markdown sections and sorts by numeric id', () => {
    assert.deepEqual(
      parseGroupPoliciesMarkdown(`
# 群聊配置

## 群 222

- participation: mentions

只在有人明确找她时回应。

## 群 111

- participation: active
- resident-hint: 熟悉的技术群，适合分享研究成果。

这里允许低门槛短句接话。

## 群 333

- participation: selective
`),
      [
        {
          id: 111,
          participation: 'active',
          residentHint: '熟悉的技术群，适合分享研究成果。',
          guidance: '这里允许低门槛短句接话。',
        },
        { id: 222, participation: 'mentions', guidance: '只在有人明确找她时回应。' },
        { id: 333, participation: 'selective', guidance: '' },
      ],
    )
  })

  test('allows a document with no group sections for private-chat-only mode', () => {
    assert.deepEqual(parseGroupPoliciesMarkdown('# 群聊配置\n\n暂无监听群。'), [])
  })

  test('rejects invalid headings, ids, duplicate groups, missing modes, and unknown modes', () => {
    for (const value of [
      '## 111\n\n- participation: active',
      '## 群 0\n\n- participation: active',
      '## 群 1.5\n\n- participation: active',
      '## 群 111\n\n- participation: active\n\n## 群 111\n\n- participation: selective',
      '## 群 111\n\n没有档位',
      '## 群 111\n\n- participation: chatty',
      '## 群 111\n\n- participation: active\n- participation: selective',
      '## 群 111\n\n- participation: active\n- resident-hint: 第一条\n- resident-hint: 第二条',
      '## 群 111\n\n- participation: active\n- resident-hint:',
      `## 群 111\n\n- participation: active\n- resident-hint: ${'过'.repeat(201)}`,
      '## 群 111\n\n- participation: mentions\n- resident-hint: 不应常驻',
    ]) {
      assert.throws(() => parseGroupPoliciesMarkdown(value), /group|群|participation/i)
    }
  })

  test('derives ambient authorization from participation mode', () => {
    assert.equal(groupPolicyAllowsAmbient({ participation: 'mentions' }), false)
    assert.equal(groupPolicyAllowsAmbient({ participation: 'selective' }), true)
    assert.equal(groupPolicyAllowsAmbient({ participation: 'active' }), true)
  })
})
