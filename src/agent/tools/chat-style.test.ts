import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createChatStyleTool } from './chat-style.js'

describe('chat_style tool', () => {
  test('global scope returns style guide sections', async () => {
    const tool = createChatStyleTool({
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupPolicies: [],
    })

    assert.equal(tool.name, 'chat_style')

    const index = await tool.execute({ scope: 'global' }, undefined as never)
    const constraints = await tool.execute({ scope: 'global', section: 'constraints' }, undefined as never)
    const base = await tool.execute({ scope: 'global', section: 'base' }, undefined as never)
    const antiPatterns = await tool.execute({ scope: 'global', section: 'anti_patterns' }, undefined as never)
    const roleplay = await tool.execute({ scope: 'global', section: 'roleplay' }, undefined as never)
    const nsfw = await tool.execute({ scope: 'global', section: 'nsfw' }, undefined as never)

    assert.match(index.content as string, /Luna 按需风格指南/)
    assert.match(index.content as string, /constraints/)
    assert.match(index.content as string, /roleplay/)
    assert.match(index.content as string, /nsfw/)
    assert.doesNotMatch(index.content as string, /special_cases|section:/)
    assert.match(constraints.content as string, /聊天约束/)
    assert.match(constraints.content as string, /单条消息 ≤ 500 字/)
    assert.match(base.content as string, /participation.*允许 ambient/)
    assert.doesNotMatch(base.content as string, /你的群聊状态是半参与/)
    assert.doesNotMatch(base.content as string, /空闲时可以翻外界/)
    assert.doesNotMatch(base.content as string, /角色扮演、cosplay/)
    assert.doesNotMatch(base.content as string, /后台白名单|配置文件|ingress/)
    assert.match(antiPatterns.content as string, /反例对照/)
    assert.match(antiPatterns.content as string, /后台白名单/)
    assert.match(antiPatterns.content as string, /二次加工式接话/)
    assert.match(antiPatterns.content as string, /巴威：我也要去看漫展/)
    assert.match(antiPatterns.content as string, /复读、接龙或玩固定格式/)
    assert.match(roleplay.content as string, /角色扮演、cosplay/)
    assert.doesNotMatch(roleplay.content as string, /NSFW|色情|黄段子/)
    assert.match(nsfw.content as string, /NSFW/)
    assert.doesNotMatch(nsfw.content as string, /角色扮演、cosplay/)
    assert.equal(tool.schema.safeParse({ scope: 'global', section: 'special_cases' }).success, false)
  })

  test('group scope returns the operator participation policy', async () => {
    const tool = createChatStyleTool({
      groupIds: [222],
      metadata: { groupNames: new Map([[222, '测试群']]) },
      groupPolicies: [{ id: 222, participation: 'active', guidance: '这个群喜欢短句接梗。' }],
    })

    const result = await tool.execute({ scope: 'group', groupId: 222 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, true)
    assert.equal(payload.groupId, 222)
    assert.equal(payload.groupName, '测试群')
    assert.equal(payload.participation, 'active')
    assert.equal(payload.guidance, '这个群喜欢短句接梗。')
  })

  test('group scope rejects unmonitored groups', async () => {
    const tool = createChatStyleTool({
      groupIds: [111],
      metadata: { groupNames: new Map() },
      groupPolicies: [],
    })

    const result = await tool.execute({ scope: 'group', groupId: 999 }, undefined as never)
    const payload = JSON.parse(result.content as string) as Record<string, unknown>

    assert.equal(payload.ok, false)
    assert.match(String(payload.error), /not monitored/)
  })
})
