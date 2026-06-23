import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createChatStyleTool } from './chat-style.js'

describe('chat_style tool', () => {
  test('global scope returns style guide sections', async () => {
    const tool = createChatStyleTool({
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    })

    assert.equal(tool.name, 'chat_style')

    const index = await tool.execute({ scope: 'global' }, undefined as never)
    const antiPatterns = await tool.execute({ scope: 'global', section: 'anti_patterns' }, undefined as never)

    assert.match(index.content as string, /Luna 按需风格指南/)
    assert.match(antiPatterns.content as string, /反例对照/)
  })

  test('group scope returns group frequency and body', async () => {
    const tool = createChatStyleTool({
      groupIds: [222],
      metadata: { groupNames: new Map([[222, '测试群']]) },
      groupCustomizations: [{ id: 222, frequencyHint: 'chatty', body: '这个群喜欢短句接梗。' }],
    })

    const result = await tool.execute({ scope: 'group', groupId: 222 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, true)
    assert.equal(payload.groupId, 222)
    assert.equal(payload.groupName, '测试群')
    assert.equal(payload.frequencyHint, 'chatty')
    assert.equal(payload.body, '这个群喜欢短句接梗。')
  })

  test('group scope rejects unmonitored groups', async () => {
    const tool = createChatStyleTool({
      groupIds: [111],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    })

    const result = await tool.execute({ scope: 'group', groupId: 999 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, false)
    assert.match(String(payload.error), /not monitored/)
  })
})
