import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSourceProfileTool } from './source-profile.js'

describe('source_profile tool', () => {
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
