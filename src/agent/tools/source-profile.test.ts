import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSourceProfileTool } from './source-profile.js'

describe('source_profile tool', () => {
  test('按需返回群定制正文, 不需要常驻塞进 system prompt', async () => {
    const tool = createSourceProfileTool({
      groupIds: [111, 222],
      metadata: { groupNames: new Map([[111, '阳光厨房']]) },
      groupCustomizations: [
        { id: 111, frequencyHint: 'chatty', body: '聊吃的群' },
      ],
    })

    const result = await tool.execute({ groupId: 111 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.groupId, 111)
    assert.equal(payload.groupName, '阳光厨房')
    assert.equal(payload.frequencyHint, 'chatty')
    assert.equal(payload.body, '聊吃的群')
  })

  test('未配置的群返回 normal + 空 body', async () => {
    const tool = createSourceProfileTool({
      groupIds: [222],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    })

    const result = await tool.execute({ groupId: 222 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.groupId, 222)
    assert.equal(payload.frequencyHint, 'normal')
    assert.equal(payload.body, '')
  })

  test('不在监听范围内的群返回错误', async () => {
    const tool = createSourceProfileTool({
      groupIds: [111],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    })

    const result = await tool.execute({ groupId: 999 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, false)
    assert.match(String(payload.error), /not monitored/)
  })
})
